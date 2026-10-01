/**
 * IndexedDB 底层原语
 * ------------------------------------------------------------
 * 这里只放「与业务无关」的库操作：打开数据库、建 objectStore 与索引，
 * 以及最基础的读写原语。
 *
 * 为什么要单独抽一层：
 *   业务数据（ledger / category / bill）与同步队列（outbox）都要写 IndexedDB。
 *   如果 outbox 去 import idbAdapter，而 idbAdapter 又 import outbox，
 *   就形成循环依赖。把「库本身」抽出来让两边都依赖它，依赖图保持单向。
 *
 * 两条必须遵守的约定（都是踩过的坑）：
 *   1) 写入前必须 toPlain()。IndexedDB 用结构化克隆存数据，而 Vue 的响应式
 *      对象是 Proxy，直接 put 会抛 DataCloneError。
 *   2) 「读-改-写」分两次事务。IndexedDB 的事务在跨 task 的 await 之后会失效，
 *      塞进一个事务里很容易踩 TransactionInactiveError。
 *
 * 另外注意：**存储的返回顺序不是契约**。getAll 按主键序返回，而内存数组是
 * 插入序 —— 凡是有顺序语义的地方，都要显式排序后再用。
 */

export const DB_NAME = 'ledger'
export const DB_VERSION = 2

/**
 * 按账号分区后的库名前缀（S5-5）—— `ledger_<账号前缀>`。
 *
 * 为什么需要分区：一台设备上先后登录过两个账号时，如果两者共用同一个 `ledger`
 * 库，A 残留的 outbox 条目会被下一轮同步推到 **B 的名下**（云端 `_openid` 是
 * B 的）—— 这就是「串号」。数据本身靠 `_openid` 隔离是安全的，**风险在本地队列**。
 * 把库拆开之后，B 根本看不见 A 的队列，从存储层堵死这条路。
 *
 * 为什么前缀用下划线接：与 `core/cloudId.js` 的云端别名前缀**同一套语义**
 * （同一个 `accountPrefixOf(uid)`），本地库名与云端别名能对上号，排查时好认。
 *
 * ⚠️ 与 `dbName` 的区别：`DB_NAME` 是**未分区**的库名，也是 S5 之前所有数据的
 *    安身之处。分区库用 `partitionedDbName()` 生成，两者不能混用。
 */
export const DB_PARTITION_PREFIX = 'ledger_'

/** 第一阶段的数据留在 localStorage 的这个键下（接管后不删，留作回退） */
export const LEGACY_DB_KEY = 'ledger.db.v1'
/** 第一阶段的同步队列留在 localStorage 的这个键下（搬迁后同样不删） */
export const LEGACY_OUTBOX_KEY = 'ledger.outbox.v1'

/**
 * 账号前缀 → 分区库名。
 *
 * @param {string|null|undefined} prefix `accountPrefixOf(uid)` 的结果
 * @returns {string} 形如 `ledger_hvfpnrlq`；前缀为空时退回裸 `DB_NAME`
 *   （不返回 `ledger_` 这种半截名字 —— 那会开出一个谁都想不到的库）
 */
export function partitionedDbName(prefix) {
  const p = String(prefix || '').trim()
  if (!p) return DB_NAME
  return `${DB_PARTITION_PREFIX}${p}`
}

/** 是否是一个按账号分区出来的库名 */
export function isPartitionedDbName(name) {
  return typeof name === 'string' && name.startsWith(DB_PARTITION_PREFIX)
}

export const STORES = {
  LEDGER: 'ledger',
  CATEGORY: 'category',
  BILL: 'bill',
  OUTBOX: 'outbox',
  META: 'meta'
}

/** meta 表的键（这张表就是个简单的键值仓） */
export const META_KEYS = {
  /** 已落库的数据结构版本 */
  SCHEMA: 'schemaVersion',
  /** 演示数据种子迁移的进度标记 */
  SEED: 'seedMeta',
  /** 是否已从 localStorage 接管过业务数据 */
  IMPORTED: 'importedFromLocalStorage',
  /** 是否已从 localStorage 搬过 outbox 队列 */
  OUTBOX_IMPORTED: 'outboxImported',
  /** 增量拉取的水位线：上次同步到的服务端时间 */
  WATERMARK: 'syncWatermark',
  /**
   * 是否已把「未分区的旧库」搬进本分区库（S5-5）。
   * ⚠️ 这个标记**写在目标（分区）库里**，语义是「我这份是从旧库继承来的」，
   *    不是「我搬过家」—— 否则两个账号会互相抢着搬。
   */
  PARTITION_MIGRATED: 'partitionMigratedFrom',
  /**
   * 裸库被哪个账号分区「认领」了（S5-5 加固）。
   *
   * ⚠️ 这个标记**写在裸库里**，与 `PARTITION_MIGRATED` 方向相反，两者缺一不可：
   *   - 目标库的 `PARTITION_MIGRATED`：「我继承过了」，防**同一账号**重复搬；
   *   - 裸库的 `PARTITION_CLAIMED`：「我已经有主了」，防**不同账号**都来搬。
   *
   * 没有后者会漏一个真实的串号场景：设备上先登录 A（A 的分区继承了裸库），
   * 之后又登录 B —— B 的分区是新的、空的，于是**也**把裸库那份搬过去，
   * 接着首次绑定把 A 的数据整批推到 B 名下。裸库因为「不删源」永远还在，
   * 这个洞会一直开着。记下认领者前缀，B 一看「已被 A 认领」就空手进。
   */
  PARTITION_CLAIMED: 'partitionClaimedBy',
  /**
   * 本分区的「本地文档已整体入队过」（S7-7）。
   *
   * 登录后的账号分区里，基础设施（账本 + 默认分类）是适配器**直接写进库**的
   * —— 不走写路径，所以不在 outbox 里。`enqueueAll()` 把它们入队一次推上云，
   * 靠这个标记保证幂等（否则每次登录都要把几百条文档重新入队）。
   *
   * ⚠️ `clearLocalData()`（退出登录）时**保留它**：同一个分区再登录时本地是
   *    空的（内容从云端全量回拉），没有东西需要再入队。
   */
  LOCAL_PUSHED: 'localPushedToCloud'
}

/** 见文件头约定 1 */
export const toPlain = (doc) => JSON.parse(JSON.stringify(doc))

/** 打开数据库（含建库与索引；已存在则直接复用） */
export function openDB({ dbName = DB_NAME, version = DB_VERSION } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('[ledger] 当前环境不支持 IndexedDB'))
      return
    }
    const req = indexedDB.open(dbName, version)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORES.LEDGER)) {
        db.createObjectStore(STORES.LEDGER, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORES.CATEGORY)) {
        const store = db.createObjectStore(STORES.CATEGORY, { keyPath: 'id' })
        store.createIndex('ledgerId', 'ledgerId')
        store.createIndex('parentId', 'parentId')
        store.createIndex('type', 'type')
        store.createIndex('updatedAt', 'updatedAt')
      }
      if (!db.objectStoreNames.contains(STORES.BILL)) {
        const store = db.createObjectStore(STORES.BILL, { keyPath: 'id' })
        store.createIndex('ledgerId', 'ledgerId')
        store.createIndex('date', 'date')
        store.createIndex('month', 'month')
        store.createIndex('categoryId', 'categoryId')
        store.createIndex('updatedAt', 'updatedAt')
      }
      if (!db.objectStoreNames.contains(STORES.OUTBOX)) {
        const store = db.createObjectStore(STORES.OUTBOX, { keyPath: 'id' })
        store.createIndex('synced', 'synced')
      }
      if (!db.objectStoreNames.contains(STORES.META)) {
        db.createObjectStore(STORES.META, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () =>
      reject(new Error('[ledger] 数据库升级被其它标签页占用，请关闭其它页签后重试'))
  })
}

/* ---------------- 基础读写原语 ---------------- */

export function readAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

export function readOne(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

/** 批量 upsert（一个事务内写完，要么都成功要么都不写） */
export function putMany(db, storeName, docs) {
  if (!docs || !docs.length) return Promise.resolve(0)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    docs.forEach((doc) => store.put(toPlain(doc)))
    tx.oncomplete = () => resolve(docs.length)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('[ledger] 写入事务被中止'))
  })
}

/** 批量删除（outbox 的压缩与作废用） */
export function removeMany(db, storeName, keys) {
  if (!keys || !keys.length) return Promise.resolve(0)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    keys.forEach((key) => store.delete(key))
    tx.oncomplete = () => resolve(keys.length)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('[ledger] 删除事务被中止'))
  })
}

export function clearStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).clear()
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error)
  })
}

/* ---------------- meta 键值仓 ---------------- */

export async function readMeta(db) {
  const rows = await readAll(db, STORES.META)
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

export function writeMeta(db, patch) {
  return putMany(
    db,
    STORES.META,
    Object.entries(patch).map(([key, value]) => ({ key, value }))
  )
}

/** 基于 meta 表的键值仓（syncEngine 用它存水位线） */
export function createIdbKeyValue(dbPromise) {
  return {
    async get(key) {
      const meta = await readMeta(await dbPromise)
      return meta[key]
    },
    async set(key, value) {
      await writeMeta(await dbPromise, { [key]: value })
      return true
    },
    async remove(key) {
      await removeMany(await dbPromise, STORES.META, [key])
      return true
    }
  }
}

/* ---------------- S5-5 库分区搬迁 ---------------- */

/** 业务数据表（meta 单独处理，搬迁时要挑着搬） */
const DATA_STORES = [STORES.LEDGER, STORES.CATEGORY, STORES.BILL]

/**
 * 把「未分区的旧库」（`ledger`）里的数据搬进本分区库。
 *
 * ## 什么时候会用到
 *
 * S5 之前所有数据都在裸 `ledger` 库里。第一次按账号分区时，如果直接开一个
 * `ledger_<prefix>` 空库，用户会以为「记账全丢了」—— 实际上数据好好地躺在旧库里。
 * 所以首次进入分区库时要**继承**一次。
 *
 * ## 为什么不删旧库
 *
 * 与 S1 接管 localStorage 的策略一致：**导入后不删源**。原因有两个：
 *   1. 可回退 —— 万一分区逻辑有问题，用户手动清掉新库还能回到旧数据；
 *   2. 身份判断可能出错 —— 「当前 uid」在启动早期未必已经拿到，
 *      搬错了（把 A 的数据搬进 B 的库）还有机会人工纠正。
 * 本项目的账目是个人数据，宁可留冗余副本也不冒丢数据的风险。
 *
 * ## 为什么标记写在**目标库**里
 *
 * 标记 `partitionMigratedFrom` 落在新库的 meta 表。语义是「我这份已经从旧库
 * 继承过了」。如果反过来把标记写进旧库（「我搬过家了」），那么第二个账号
 * 会看到旧库的标记，**继承不到本该属于它的那份数据**，直接开空库 —— 更糟。
 *
 * ## 只搬「还没有人认领」的情况
 *
 * 调用方（api/index.js）负责判断策略，这里只做机械动作：
 * 目标库非空 → 什么都不做（不覆盖用户已经产生的数据）。
 *
 * ## 裸库只能被认领一次（S5-5 加固）
 *
 * 裸库「不删源」，所以它会永远留在这台设备上。如果没有认领概念，
 * 设备上登录的**每一个新账号**都会把同一份裸库数据搬进自己的分区，
 * 紧接着首次绑定把它推上云端 —— 一个账号的账就进了另一个账号的名下。
 *
 * 于是搬之前先看裸库的 `partitionClaimedBy`：
 *   - 没有 ⇒ 就是「首次分区」，本分区认领它（写下自己的前缀），然后搬；
 *   - 有且等于自己 ⇒ 之前搬过但没搬完（比如上次被打断），继续搬；
 *   - 有且是别人 ⇒ **空手进**，一个字节都不动，只在自己库里记「我不继承」。
 *
 * @param {Promise<IDBDatabase>} targetDbPromise 目标（分区）库
 * @param {object} options
 * @param {string} [options.sourceDbName] 源（旧）库名，默认 `DB_NAME`
 * @param {string} [options.migratedFrom] 记进目标库标记的源库名（默认同 sourceDbName）
 * @param {string} [options.claimant] 本分区的认领标识（通常是账号前缀）。
 *   传空则退化成「不检查认领」的老行为（测试与未分区场景用）
 * @param {boolean} [options.force] 跳过「目标库非空」检查（测试用）
 * @returns {Promise<{migrated: boolean, reason: string, counts?: object}>}
 */
export async function migratePartitionData(
  targetDbPromise,
  { sourceDbName = DB_NAME, migratedFrom = sourceDbName, claimant = '', force = false } = {}
) {
  const target = await targetDbPromise
  const targetMeta = await readMeta(target)

  if (targetMeta[META_KEYS.PARTITION_MIGRATED]) {
    return { migrated: false, reason: 'already-migrated' }
  }

  // 目标库已经有数据 ⇒ 不覆盖。用户可能已经在这个账号下记了新账，
  // 把它换成旧库内容属于「静默回退用户数据」，绝对不能做。
  if (!force) {
    const existing = await Promise.all(DATA_STORES.map((s) => readAll(target, s)))
    if (existing.some((rows) => rows.length > 0)) {
      // 已经有东西了，直接补标记，免得每次启动都来扫一遍
      await writeMeta(target, { [META_KEYS.PARTITION_MIGRATED]: migratedFrom })
      return { migrated: false, reason: 'target-not-empty' }
    }
  }

  // 打开旧库。⚠️ 用**不带升级**的方式打开：如果旧库压根不存在，
  // indexedDB.open 会顺手创建一个空的 —— 那正好，读出来就是空数组，
  // 但会留下一个无意义的空库。这里接受这个副作用（旧库本来就会长期存在）。
  let source = null
  try {
    source = await openDB({ dbName: sourceDbName })
  } catch (e) {
    // 旧库打不开（版本冲突 / 被别的标签页占着）—— 不搬了，但**不写标记**，
    // 下次启动再试。写标记会让这一次失败变成永久放弃。
    return { migrated: false, reason: 'source-unavailable' }
  }

  const sourceMeta = await readMeta(source)

  /**
   * 认领检查：裸库已经有主、且主不是自己 ⇒ 空手进。
   *
   * ⚠️ 判定用**前缀**而不是完整 uid：与库名派生同源（`accountPrefixOf`），
   *    同一个账号无论 uid 有没有变化都能认出「是我搬的」。
   *    为空（未传 claimant）时跳过检查，保留老行为。
   */
  const claimedBy = sourceMeta[META_KEYS.PARTITION_CLAIMED]
  if (claimant && claimedBy && claimedBy !== claimant) {
    // 在自己库里记一笔「已确认不继承」，免得每次启动都重算一遍
    await writeMeta(target, { [META_KEYS.PARTITION_MIGRATED]: `declined:${claimedBy}` })
    return { migrated: false, reason: 'claimed-by-other', claimedBy }
  }

  const hasAnything = await Promise.all(DATA_STORES.map((s) => readAll(source, s)))
  const counts = {}
  let moved = 0
  for (let i = 0; i < DATA_STORES.length; i += 1) {
    const name = DATA_STORES[i]
    const rows = hasAnything[i]
    counts[name] = rows.length
    if (rows.length) {
      await putMany(target, name, rows)
      moved += rows.length
    }
  }
  // outbox 队列也要继承 —— 否则旧库那批「还没推上去的改动」会凭空消失
  const sourceOutbox = await readAll(source, STORES.OUTBOX)
  if (sourceOutbox.length) {
    await putMany(target, STORES.OUTBOX, sourceOutbox)
    counts[STORES.OUTBOX] = sourceOutbox.length
    moved += sourceOutbox.length
  }

  /**
   * meta 只继承**进度类**标记，不继承账号相关的：
   *   - 继承：`schemaVersion` / `seedMeta`（演示数据迁移进度）/ 两个 imported 标记
   *   - 继承水位线：旧库的水位线是「这个账号已经拉到哪了」，跟着走才不会重复全量拉；
   *     但**前提是旧库本来就属于同一个账号**。启动早期拿不准时应由调用方决定
   *     是否传 `inheritWatermark: false`。
   */
  const inherited = {}
  for (const key of [
    META_KEYS.SCHEMA,
    META_KEYS.SEED,
    META_KEYS.IMPORTED,
    META_KEYS.OUTBOX_IMPORTED
  ]) {
    if (sourceMeta[key] !== undefined) inherited[key] = sourceMeta[key]
  }
  if (Object.keys(inherited).length) await writeMeta(target, inherited)

  // 认领裸库（只有真搬了东西才认领；空手进时不该把它占下来）
  if (claimant && moved > 0) {
    await writeMeta(source, { [META_KEYS.PARTITION_CLAIMED]: claimant })
  }

  await writeMeta(target, { [META_KEYS.PARTITION_MIGRATED]: migratedFrom })

  /**
   * ⚠️ 三种结局要分清，调用方靠 `reason` 决定「要不要播种」：
   *   - `migrated` —— 真搬到东西了。**别播种**（会与旧数据叠成两套）。
   *   - `empty-source` —— 旧库是空的（全新设备就是这样）。**要播种**，
   *     否则新用户进来看到的是一个空荡荡的 App。
   *   - `claimed-by-other` / `target-not-empty` —— 内容已定案，别播种。
   *
   * 曾经把「旧库为空」也返回成 `migrated`，结果全新设备第一次启动就
   * 跳过播种、首页全是 0.00 —— 这是个只有真机首启才暴露的 bug。
   */
  if (moved === 0) return { migrated: false, reason: 'empty-source', counts }
  return { migrated: true, reason: 'migrated', counts }
}
