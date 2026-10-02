import { COLLECTIONS, NAME_MAX_LENGTH, RepositoryError, SCHEMA_VERSION } from '../contract.js'
import { createOutbox } from '../sync/outbox.js'
import { createIdbOutboxStore } from '../sync/outboxStore.js'
import { buildSeed, SEED_MODE } from '../mock/seed.js'
import { migrateSeedData } from '../core/migrate.js'
import { IS_DEV } from '../../config/env.js'
import { partitionRemote } from '../core/merge.js'
import {
  DB_NAME,
  DB_VERSION,
  LEGACY_DB_KEY,
  META_KEYS,
  STORES,
  clearLegacyLocalKeys as idbClearLegacyLocalKeys,
  clearStore as idbClearStore,
  createIdbConnection,
  createIdbKeyValue,
  migratePartitionData,
  openDB,
  putMany as idbPutMany,
  readAll as idbReadAll,
  readMeta as idbReadMeta,
  readOne as idbReadOne,
  toPlain,
  writeMeta as idbWriteMeta
} from '../core/idb.js'
import { now, uid } from '../../utils/id.js'
import { todayKey } from '../../utils/date.js'
import { round2 } from '../../utils/money.js'
import {
  alive,
  createCategoryLookup,
  filterCategories,
  filterBills,
  groupBillsByDate,
  dailySummaryOf,
  summarizeBills,
  remarkHistoryOf,
  decorateBill
} from '../core/query.js'

/**
 * IndexedDB 适配器（第二阶段 · 本地离线缓存）
 * ------------------------------------------------------------
 * 与 mockAdapter 实现**同一套契约**（见 contract.js），切换方式只有一处：
 *
 *   // src/api/index.js
 *   export const DATA_SOURCE = 'idb'
 *
 * 设计取舍（为什么这么写）：
 *
 *  1) 业务规则不在这里重写一遍。过滤、排序、聚合、派生字段、种子迁移、远端合并
 *     全部来自 core/ 目录（query.js / migrate.js / merge.js），与 mockAdapter
 *     共用同一份实现，从构造上杜绝「两个适配器行为漂移」。
 *
 *  2) 读写分两次事务：先读（readAll）→ 纯 JS 计算 → 再写（putMany）。
 *     IndexedDB 的事务在跨 task 的 await 之后会失效，把「读-改-写」塞进一个
 *     事务里很容易踩 TransactionInactiveError；页面内操作是单线程串行的，
 *     不存在并发写入，因此这里用「读一次、写一次」换取可靠与可读。
 *     （同源多标签页同时写同一条属于未覆盖场景，接云端后由 updatedAt 新者胜兜底。）
 *
 *  3) 查询用 readAll 把集合读进内存再算。个人记账的数据量（千条级）下
 *     getAll 是毫秒级。
 *
 *  4) **同步队列与业务数据同库**。S1 时 outbox 还在 localStorage，S2 把它
 *     搬进了 IndexedDB 的 outbox 表 —— 同一个库、同一套事务语义、同一份备份，
 *     不用再操心「两套存储各自什么时候丢」。
 *
 *  5) 首次使用会**接管第一阶段留在 localStorage 里的数据**（见 LEGACY_DB_KEY），
 *     导入后不删除旧库，留作回退；导入只做一次，靠 meta 标记判断。
 *
 *  6) 真正的推送/拉取不在这里，而在 sync/syncEngine.js。适配器只做两件事：
 *     写的时候把改动 `enqueue` 进队列（**先落数据、再入队**），
 *     以及给引擎提供一个「读一条 / 写回一批」的本地读写口（`syncStore`）。
 *     同步是跨集合、跨存储的行为，不属于某个适配器。
 */

export { STORES, openDB }

const LEGACY_KEY = LEGACY_DB_KEY

/**
 * @returns 与 mockAdapter 同契约的适配器实例
 */
export function createIdbAdapter(options = {}) {
  const {
    dbName = DB_NAME,
    version = DB_VERSION,
    /**
     * 播种档位（S7-9）。**三态**：
     *   - `true` / `'full'` —— 基础设施（账本 + 分类）**加演示账单**。
     *     现在只有「重置演示数据」抬档时用（见 `reset()`）—— 任何分区
     *     的常规启动都不再播演示账单。
     *   - `'base'` —— **只播基础设施**（账本 + 分类），一条演示账单都没有。
     *     未登录分区、登录后的账号分区都用它 ——
     *     账号里凭空多出 ¥8720.72 演示账就是这套种子推上去的（见 mock/seed.js）。
     *   - `false` —— 什么都不播。测试要的空库走这条。
     */
    seed = true,
    /**
     * 播种出来的**分类**专用 `updatedAt`。
     *
     * 登录后的账号分区必须传 `0`（见 `mock/seed.js` 的 `buildBase`）：那份默认分类
     * 只是「本地兜底」，时间戳最新会让它盖掉用户在云端改过的分类名。
     */
    seedCategoryUpdatedAt = null,
    /**
     * S5-5：从「未分区的旧库」继承数据（只在分区库里用）。
     *   - `false`（默认）—— 不继承。裸库与测试走这条路。
     *   - `true` —— 用默认源库名（`ledger`）。
     *   - 字符串 —— 指定源库名。
     * 语义与幂等保证见 `core/idb.js` 的 `migratePartitionData`。
     */
    migrateFrom = false,
    /**
     * S5-5：本分区的认领标识（通常是账号前缀）。
     *
     * 裸库「不删源」，会长期留着。有了它，裸库只能被**第一个**分区认领，
     * 之后登录的别的账号不会再把同一份数据搬进自己名下（防跨账号串号）。
     * 传空 = 不做认领检查（测试 / 未分区场景）。
     */
    claimant = '',
    /**
     * S7-9 补丁：启动时做一次「演示账单清理」（只有未登录分区传 true）。
     *
     * guest 改为只播 `'base'` 之前，更早的开发构建已经给 guest 分区播过
     * 整套演示账单。未登录写路径被门禁拦着 ⇒ guest 库里的账单**只可能
     * 来自种子**，整批清掉是安全的。靠 `META_KEYS.SEED_BILLS_PURGED`
     * 保证只清一次（不然「重置演示数据」灌进去的演示账单活不过下次启动）。
     */
    purgeSeedBills = false
  } = options

  /** 归一化播种档位：`false` → 不播；`'base'` → 只播基础设施；其余 → 整套 */
  const seedMode = seed === false ? false : seed === 'base' ? SEED_MODE.BASE : SEED_MODE.FULL
  /** 是否播了演示账单 —— 决定要不要跑「演示数据迁移」（补种） */
  const seedWantsDemo = seedMode === SEED_MODE.FULL

  /**
   * 连接层（探活 + 自动重连，见 core/idb.js 的 createIdbConnection）。
   *
   * ⚠️ 不能再是「`dbPromise ||= openDB(...)` 一缓存到底」：Chrome 会单方面
   *    关掉空闲连接（真机实测 2026-10-02：无痕窗口退出后再登录，登录链路
   *    全线抛 connection is closing）。旧的缓存写法死了就永远死了。
   */
  const conn = createIdbConnection({ dbName, version })
  const getDB = () => conn.acquire()

  let initPromise = null
  /** 非 null 时，下一次 `init()` 用它当播种档位（只被 `reset()` 设置，见 init 里的说明） */
  let pendingResetMode = null

  /** 队列与业务数据同库；换账号时只需把 dbName 换掉即可实现分区（见 S5） */
  const outbox = createOutbox(createIdbOutboxStore({ dbName, version }))
  /** 键值仓，syncEngine 用它存水位线。传连接对象而非裸 Promise（要跟着重连走） */
  const kv = createIdbKeyValue(conn)

  /* ---------------- 底层读写（薄包装，绑定本实例的 db） ---------------- */

  const readAll = (storeName) => getDB().then((db) => idbReadAll(db, storeName))
  const readOne = (storeName, key) => getDB().then((db) => idbReadOne(db, storeName, key))
  const putMany = (storeName, docs) => getDB().then((db) => idbPutMany(db, storeName, docs))
  const clearStore = (storeName) => getDB().then((db) => idbClearStore(db, storeName))
  const readMeta = () => getDB().then((db) => idbReadMeta(db))
  const writeMeta = (patch) => getDB().then((db) => idbWriteMeta(db, patch))

  /* ---------------- 初始化：接管旧数据 / 播种 / 迁移 ---------------- */

  /** 读取第一阶段留在 localStorage 里的库（读取失败或版本不符时返回 null） */
  function readLegacy() {
    if (typeof localStorage === 'undefined') return null
    try {
      const raw = localStorage.getItem(LEGACY_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw)
      if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION) return null
      if (!Array.isArray(parsed.bills) || !Array.isArray(parsed.categories)) return null
      return {
        ledgers: parsed.ledgers || [],
        categories: parsed.categories,
        bills: parsed.bills,
        meta: parsed.meta || {}
      }
    } catch (e) {
      return null
    }
  }

  /** 幂等的演示数据迁移（规则见 core/migrate.js），只写回有变化的部分 */
  async function runSeedMigration() {
    const meta = await readMeta()
    const seedMeta = meta[META_KEYS.SEED] || {}
    const bills = await readAll(STORES.BILL)
    const result = migrateSeedData(bills, seedMeta)
    if (result.changed) {
      await putMany(STORES.BILL, [...result.added, ...result.updated])
      await writeMeta({ [META_KEYS.SEED]: seedMeta })
    }
    return result.changed
  }

  /* ---------------- 废弃字段清理（S8-5） ---------------- */

  /**
   * 已从契约里删除、但仍可能留在历史文档上的字段。
   *
   * 三个字段的共同点：**从写入到读取都没有任何消费者**。
   *   - 账单 `noReimburse` —— 「不报销」开关 S7-10 已从记账页下线，写入恒 false；
   *   - 账单 `version`     —— 早期设想的「服务端同步版本号」，从未被读取
   *     （跨设备裁决走 `updatedAt` / 云端 `serverUpdatedAt`）；
   *   - 账本 `ownerId`     —— 第一阶段还没有账号体系时的占位，值恒 `'user_local'`；
   *     真正的归属在云端是 `_openid`、在本地是库分区。
   */
  const DEPRECATED_FIELDS = {
    [STORES.LEDGER]: ['ownerId'],
    [STORES.BILL]: ['noReimburse', 'version']
  }

  /** 清理规则的版本；将来再删字段就 +1，老库会自己补跑 */
  const DEPRECATED_FIELDS_VERSION = 1

  /**
   * 逐条删掉历史文档上的废弃字段（一次性、幂等；只写回真正有变化的文档）。
   *
   * ⚠️ **刻意不动 `updatedAt`、也不入 outbox**。这是纯存储卫生，不是用户改内容：
   *    抬了时间戳，这条账就会在下一轮同步里被判成「本地更新」而推送 ——
   *    既去改云端那份，又可能顶掉别的设备上的新修改。不入队则两端各清各的，
   *    等用户哪天真去改这条账时，`.set()` 的整份覆盖会自然收敛。
   *    （云端那份由管理端 `$unset` 一次性清掉。）
   *
   * @returns {Promise<number>} 实际被改写的文档条数
   */
  async function purgeDeprecatedFields() {
    let touched = 0
    for (const [storeName, fields] of Object.entries(DEPRECATED_FIELDS)) {
      const rows = await readAll(storeName)
      const next = []
      for (const row of rows) {
        const hits = fields.filter((f) => Object.prototype.hasOwnProperty.call(row, f))
        if (!hits.length) continue
        const copy = toPlain(row)
        hits.forEach((f) => delete copy[f])
        next.push(copy)
        touched += 1
      }
      if (next.length) await putMany(storeName, next)
    }
    return touched
  }

  async function init() {
    await getDB()

    /**
     * 本次建库用的播种档位。
     *
     * ⚠️ 为什么不是直接用实例级的 `seedMode`：`reset()`（「我的 → 重置演示数据」）
     *    清库后会**重新走一遍 init**，而那一次的意图是「给我一份完整的演示数据」——
     *    即使这是个只播基础设施的账号分区。所以 reset 会先把这个临时档位设上。
     *    生产构建下不抬档：那个按钮本来就不该出现（它会连云端一起清）。
     */
    const mode = pendingResetMode || seedMode
    const wantsDemo = mode === SEED_MODE.FULL

    /**
     * S5-5：先继承旧（未分区）库，再走后面的接管/播种判断。
     *
     * 顺序很关键 —— 继承进来的数据要能**挡住播种**：如果先播种再继承，
     * 用户会看到「种子数据 + 自己原来的账」混在一起，旧数据反而像被污染了。
     */
    /**
     * 「继承已定案，别再播种」。按继承结局分三种：
     *
     *   - `migrated` —— 真搬来了旧数据，库里已有权威内容 ⇒ **不播种**。
     *   - `target-not-empty` / `already-migrated` —— 本分区内容已定案 ⇒ 不播种。
     *   - `claimed-by-other` —— 裸库属于**别的账号**，本分区空手进 ⇒ **不播种**。
     *     若还播种，新账号一进去就看到一份演示数据，首次绑定把它整批推到
     *     自己名下 —— 等于凭空多了别人的账（跨账号串号的另一条路）。
     *   - `empty-source` —— 旧库是空的（全新设备）⇒ **要播种**，否则新用户
     *     第一次打开看到的是空 App。这个 case 曾经被误判成 `migrated`。
     *   - `source-unavailable` —— 旧库被占着打不开，只是暂时读不到，
     *     下次启动要重试 ⇒ **不播种**（顺手种下去会让重试失去意义）。
     */
    let inheritSettled = false
    if (migrateFrom) {
      const res = await migratePartitionData(getDB(), {
        sourceDbName: typeof migrateFrom === 'string' ? migrateFrom : DB_NAME,
        claimant
      })
      // 只有「旧库确实空着」才把播种让给种子逻辑；其余结局都算定案
      inheritSettled = res.reason !== 'empty-source'
    }

    const meta = await readMeta()

    if (meta[META_KEYS.SCHEMA] !== SCHEMA_VERSION) {
      // 已经接管过一次就不再接管：否则用户点过「重置演示数据」后，
      // 旧库又会被重新导入一遍，把重置结果覆盖掉
      const legacy = meta[META_KEYS.IMPORTED] ? null : readLegacy()

      if (legacy) {
        await putMany(STORES.LEDGER, legacy.ledgers)
        await putMany(STORES.CATEGORY, legacy.categories)
        await putMany(STORES.BILL, legacy.bills)
        await writeMeta({ [META_KEYS.SEED]: legacy.meta, [META_KEYS.IMPORTED]: now() })
      } else if (mode && !inheritSettled) {
        // ⚠️ `inheritSettled` 时**不播种**：分区库的内容已由继承判定决定。
        //    再播一份种子会与继承来的数据叠成两套，而且种子 id 固定，
        //    会直接把用户的同名账目覆盖掉。
        //
        // S7-9：种子分两层 —— `'base'` 只给账本 + 分类（**没有演示账单**），
        // `'full'` 才带上那 44 条演示账。账号分区用 `'base'`，否则新账号
        // 一登录就把这份演示数据整批推上云（¥8720.72 凭空出现）。
        const seedData = buildSeed(Date.now(), {
          mode,
          categoryUpdatedAt: seedCategoryUpdatedAt
        })
        await putMany(STORES.LEDGER, seedData.ledgers)
        await putMany(STORES.CATEGORY, seedData.categories)
        if (seedData.bills.length) await putMany(STORES.BILL, seedData.bills)
        await writeMeta({ [META_KEYS.SEED]: seedData.meta || {} })
      }
      await writeMeta({ [META_KEYS.SCHEMA]: SCHEMA_VERSION })
    }

    /**
     * S8-5：清掉历史文档上的废弃字段。
     *
     * 放在播种 / 接管**之后**：那两条路径刚写进来的文档已经不含废弃字段，
     * 但这个顺序能让「老库首次启动」一次就把库里所有文档过一遍。
     * 幂等靠独立标记 —— 见 `META_KEYS.DEPRECATED_FIELDS_PURGED` 的说明。
     */
    if (meta[META_KEYS.DEPRECATED_FIELDS_PURGED] !== DEPRECATED_FIELDS_VERSION) {
      await purgeDeprecatedFields()
      await writeMeta({ [META_KEYS.DEPRECATED_FIELDS_PURGED]: DEPRECATED_FIELDS_VERSION })
    }

    // 队列搬迁（旧 localStorage → IndexedDB）在这里顺带做完，
    // 幂等标记由 outboxStore 负责
    await outbox.store.prepare?.()

    // 演示数据迁移（补备注 / 补补充账单）：
    //   - `seed=false`（测试用的空库）必须跳过，否则会把演示账单当成
    //     「缺失的补充数据」补进来；
    //   - S7-9 起还要 **`'base'` 档位也跳过** —— 那个分区里压根没有演示账单，
    //     跑迁移等于把它们凭空补进一个不该有演示数据的账号分区。
    if (wantsDemo && !inheritSettled) await runSeedMigration()

    /**
     * S7-9 补丁：未登录分区的「演示账单一次性清理」。
     *
     *   - 抬档 FULL（开发构建的「重置演示数据」）时**跳过清理** —— 那次
     *     init 刚把演示账单灌进去，不能自己清自己；
     *   - 但**照样落标记** —— 标记的语义是「这个分区做过清理裁决了」，
     *     落了标记，重置灌进去的演示账单才不会在下次启动（mode 回到
     *     `'base'`）被误清。
     */
    if (purgeSeedBills && !meta[META_KEYS.SEED_BILLS_PURGED]) {
      if (mode !== SEED_MODE.FULL) await clearStore(STORES.BILL)
      await writeMeta({ [META_KEYS.SEED_BILLS_PURGED]: now() })
    }
    return true
  }

  /** 所有对外方法都先 await 它，保证「建库 → 接管/播种 → 迁移」只跑一次 */
  function ready() {
    if (!initPromise) initPromise = init()
    return initPromise
  }

  /**
   * 入队。
   * 刻意 try/catch 掉：**绝不能因为队列写不进去而让用户的账白记** ——
   * 数据已经落库了，同步晚一轮是小事，丢一笔账是大事。
   */
  async function enqueue(collection, op, docId, payload) {
    try {
      await outbox.enqueue({
        id: uid('ob'),
        collection,
        op,
        docId,
        payload,
        ts: now()
      })
    } catch (e) {
      console.error('[ledger] 同步队列写入失败，该条改动本轮不会上云', e)
    }
  }

  /* ---------------- 账本 ---------------- */

  const ledgerApi = {
    async list() {
      await ready()
      return (await readAll(STORES.LEDGER)).map((l) => ({ ...l }))
    },

    async get(id) {
      await ready()
      const item = await readOne(STORES.LEDGER, id)
      return item ? { ...item } : null
    },

    async update(id, patch) {
      await ready()
      const item = await readOne(STORES.LEDGER, id)
      if (!item) throw new RepositoryError('NOT_FOUND', '账本不存在')
      const next = { ...item, ...patch, updatedAt: now() }
      await putMany(STORES.LEDGER, [next])
      await enqueue(COLLECTIONS.LEDGER, 'update', id, { ...next })
      return { ...next }
    }
  }

  /* ---------------- 分类 ---------------- */

  const categoryApi = {
    /** @param {{ledgerId?:string, type?:string, parentId?:string|null, includeDeleted?:boolean}} query */
    async list(query = {}) {
      await ready()
      return filterCategories(await readAll(STORES.CATEGORY), query)
    },

    async get(id) {
      await ready()
      const cat = await readOne(STORES.CATEGORY, id)
      return cat && alive(cat) ? { ...cat } : null
    },

    async listChildren(parentId) {
      await ready()
      return filterCategories(await readAll(STORES.CATEGORY), { parentId })
    },

    /**
     * @param {{name:string, icon:string, parentId?:string|null, type:string, ledgerId:string}} payload
     */
    async create(payload) {
      await ready()
      const categories = await readAll(STORES.CATEGORY)

      const name = String(payload.name || '').trim()
      if (!name) throw new RepositoryError('EMPTY_NAME', '请输入分类名称')
      if (name.length > NAME_MAX_LENGTH) {
        throw new RepositoryError('NAME_TOO_LONG', `分类名称最多 ${NAME_MAX_LENGTH} 个字`)
      }

      const parentId = payload.parentId || null
      if (parentId && !categories.some((c) => c.id === parentId && alive(c))) {
        throw new RepositoryError('PARENT_NOT_FOUND', '所属一级分类不存在')
      }

      const duplicated = categories.some(
        (c) =>
          alive(c) &&
          c.name === name &&
          c.type === payload.type &&
          (c.parentId || null) === parentId &&
          c.ledgerId === payload.ledgerId
      )
      if (duplicated) throw new RepositoryError('DUPLICATE_NAME', '分类名称已存在')

      // order 与 mockAdapter 保持一致：同级同类型同账本的下一个序号
      const siblings = categories.filter(
        (c) => c.parentId === parentId && c.type === payload.type && c.ledgerId === payload.ledgerId
      )
      const doc = {
        id: uid(payload.parentId ? 'sub' : 'cat'),
        name,
        icon: payload.icon || 'more',
        parentId,
        type: payload.type,
        ledgerId: payload.ledgerId,
        order: siblings.length,
        createdAt: now(),
        updatedAt: now(),
        deleted: 0
      }
      await putMany(STORES.CATEGORY, [doc])
      await enqueue(COLLECTIONS.CATEGORY, 'create', doc.id, { ...doc })
      return { ...doc }
    },

    async update(id, patch) {
      await ready()
      const categories = await readAll(STORES.CATEGORY)
      const doc = categories.find((c) => c.id === id && alive(c))
      if (!doc) throw new RepositoryError('NOT_FOUND', '分类不存在')

      const name = patch.name === undefined ? doc.name : String(patch.name).trim()
      if (!name) throw new RepositoryError('EMPTY_NAME', '请输入分类名称')
      if (name.length > NAME_MAX_LENGTH) {
        throw new RepositoryError('NAME_TOO_LONG', `分类名称最多 ${NAME_MAX_LENGTH} 个字`)
      }
      const duplicated = categories.some(
        (c) =>
          alive(c) &&
          c.id !== id &&
          c.name === name &&
          c.type === doc.type &&
          (c.parentId || null) === (doc.parentId || null)
      )
      if (duplicated) throw new RepositoryError('DUPLICATE_NAME', '分类名称已存在')

      const next = { ...doc, ...patch, name, updatedAt: now() }
      await putMany(STORES.CATEGORY, [next])
      await enqueue(COLLECTIONS.CATEGORY, 'update', next.id, { ...next })
      return { ...next }
    },

    /** 删除分类；cascade=true 时连带删除其二级分类（软删除） */
    async remove(id, { cascade = true } = {}) {
      await ready()
      const categories = await readAll(STORES.CATEGORY)
      const doc = categories.find((c) => c.id === id && alive(c))
      if (!doc) throw new RepositoryError('NOT_FOUND', '分类不存在')

      const ts = now()
      const touched = [{ ...doc, deleted: 1, updatedAt: ts }]

      if (cascade && !doc.parentId) {
        categories
          .filter((c) => c.parentId === id && alive(c))
          .forEach((child) => {
            touched.push({ ...child, deleted: 1, updatedAt: ts })
          })
      }

      await putMany(STORES.CATEGORY, touched)
      await Promise.all(
        touched.map((item) => enqueue(COLLECTIONS.CATEGORY, 'delete', item.id, { ...item }))
      )
      return { id }
    },

    /** 拖拽排序预留接口 */
    async reorder(orderedIds) {
      await ready()
      const categories = await readAll(STORES.CATEGORY)
      const ts = now()
      const touched = []
      orderedIds.forEach((id, index) => {
        const doc = categories.find((c) => c.id === id)
        if (doc) touched.push({ ...doc, order: index, updatedAt: ts })
      })
      await putMany(STORES.CATEGORY, touched)
      return orderedIds
    }
  }

  /* ---------------- 账单 ---------------- */

  const billApi = {
    /**
     * @param {{ledgerId?:string, month?:string, from?:string, to?:string, date?:string,
     *          type?:string, categoryId?:string, keyword?:string, order?:'asc'|'desc'}} query
     * from / to 为 'YYYY-MM-DD'（含首尾），与 month 同时传入时按 AND 处理
     */
    async list(query = {}) {
      await ready()
      const [bills, categories] = await Promise.all([
        readAll(STORES.BILL),
        readAll(STORES.CATEGORY)
      ])
      return filterBills(bills, categories, query)
    },

    /** 按日期分组的账单（账单页流水视图） */
    async listGrouped(query = {}) {
      return groupBillsByDate(await this.list(query))
    },

    async get(id) {
      await ready()
      const [bill, categories] = await Promise.all([
        readOne(STORES.BILL, id),
        readAll(STORES.CATEGORY)
      ])
      if (!bill || !alive(bill)) return null
      return decorateBill(bill, createCategoryLookup(categories))
    },

    async create(payload) {
      await ready()
      const amount = round2(payload.amount)
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new RepositoryError('INVALID_AMOUNT', '请输入有效的金额')
      }

      const categories = await readAll(STORES.CATEGORY)
      let category = null
      if (payload.categoryId) {
        const found = categories.find((c) => c.id === payload.categoryId && alive(c))
        category = found || null
      }
      const primaryId = category
        ? category.parentId || category.id
        : payload.primaryCategoryId || null

      const doc = {
        id: uid('bill'),
        ledgerId: payload.ledgerId,
        type: payload.type || 'expense',
        amount,
        categoryId: category ? category.id : null,
        primaryCategoryId: primaryId,
        remark: String(payload.remark || '').trim(),
        date: payload.date || todayKey(),
        createdAt: now(),
        updatedAt: now(),
        deleted: 0
      }
      await putMany(STORES.BILL, [doc])
      await enqueue(COLLECTIONS.BILL, 'create', doc.id, { ...doc })
      return decorateBill(doc, createCategoryLookup(categories))
    },

    async update(id, patch) {
      await ready()
      const doc = await readOne(STORES.BILL, id)
      if (!doc || !alive(doc)) throw new RepositoryError('NOT_FOUND', '账单不存在')

      const categories = await readAll(STORES.CATEGORY)
      const next = { ...patch }

      if (next.amount !== undefined) {
        const amount = round2(next.amount)
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new RepositoryError('INVALID_AMOUNT', '请输入有效的金额')
        }
        next.amount = amount
      }
      if (next.categoryId !== undefined) {
        const category = next.categoryId
          ? categories.find((c) => c.id === next.categoryId && alive(c)) || null
          : null
        next.categoryId = category ? category.id : null
        next.primaryCategoryId = category
          ? category.parentId || category.id
          : doc.primaryCategoryId
      }
      if (next.remark !== undefined) next.remark = String(next.remark).trim()

      const merged = {
        ...doc,
        ...next,
        updatedAt: now()
      }
      await putMany(STORES.BILL, [merged])
      await enqueue(COLLECTIONS.BILL, 'update', merged.id, { ...merged })
      return decorateBill(merged, createCategoryLookup(categories))
    },

    async remove(id) {
      await ready()
      const doc = await readOne(STORES.BILL, id)
      if (!doc || !alive(doc)) throw new RepositoryError('NOT_FOUND', '账单不存在')
      const next = { ...doc, deleted: 1, updatedAt: now() }
      await putMany(STORES.BILL, [next])
      await enqueue(COLLECTIONS.BILL, 'delete', next.id, { ...next })
      return { id }
    },

    /**
     * 区间汇总（首页 / 账单页结余卡片）
     * 用 month 传月度区间，或用 from / to 传任意区间（账单页按年筛选）
     */
    async summary(query = {}) {
      await ready()
      return summarizeBills(await readAll(STORES.BILL), query)
    },

    /** 某天的收支汇总（日历视图） */
    async dailySummary(query = {}) {
      return dailySummaryOf(await this.list({ ...query, order: 'asc' }))
    },

    /** 全账本最近 N 条（首页今日账单） */
    async recent(query = {}) {
      return this.list({ ...query, order: 'desc' })
    },

    /**
     * 某分类下的历史备注（记账页「填写备注」的候选）
     * @param {{ledgerId?:string, categoryId:string, limit?:number}} query
     * @returns {Promise<string[]>}
     */
    async remarkHistory(query = {}) {
      await ready()
      return remarkHistoryOf(await readAll(STORES.BILL), query)
    }
  }

  /* ---------------- 数据备份（S8-1） ---------------- */

  /**
   * 备份用的存储读写口。
   *
   * 业务规则（字段白名单、坏数据判定、导入合并与幂等）**全在 `core/backup.js`**，
   * 这里只做两件与存储有关的事：把三类文档**原样**读出来、把定稿的文档写回去
   * 并补进同步队列。于是「导出/导入怎么合并」与「数据存在哪」互不牵连。
   */
  const backupApi = {
    /**
     * 三类文档的原始快照（**含软删除墓碑**）。
     *
     * 这里不过滤：过滤是「备份语义」的一部分（只导活文档），属于 core 的职责；
     * 适配器只回答「库里现在有什么」。`planImport` 也需要带墓碑的本地副本，
     * 才能正确判断「备份比本地删得晚 ⇒ 该恢复」。
     */
    async dump() {
      await ready()
      const [ledgers, categories, bills] = await Promise.all([
        readAll(STORES.LEDGER),
        readAll(STORES.CATEGORY),
        readAll(STORES.BILL)
      ])
      return { ledgers, categories, bills }
    },

    /**
     * 落盘导入计划（`planImport` 的产物）。
     *
     * ⚠️ **直写底层，不走 `create()` / `update()`**，两个理由：
     *   1. `create()` 会重造 id（`uid('bill')`）—— 备份里的 id 就丢了，
     *      「同一份文件导两次」会变成两批不同的账单，**幂等当场破功**；
     *   2. 两个写方法都会把 `createdAt` / `updatedAt` 改成当前时刻，
     *      备份里的历史时间轴被抹平，同样破坏幂等（见 core/backup.js 决定 ③）。
     *
     * 所以这里像 `enqueueAll()` 一样直写，再补一次批量入队让下一轮同步带上云。
     * 入队的 `op` 用 `'update'`：推送时引擎推的是**当前本地文档**（不看 op），
     * 语义上「把这条并进来」也更接近 update 而非 create。
     *
     * ⚠️ `deleted` 统一补 0：incoming 全是活文档，写回要覆盖本地可能存在的墓碑
     *    （备份里活着 ⇒ 这条账是被恢复的）。
     *
     * ## `remove` 桶（恢复模式专用）
     *
     * 「本机有、备份里没有」的活文档要清掉。**只写墓碑、绝不物理删除**：
     * 墓碑才是同步机制里「这条被删了」的表达，硬删会让其他设备的下一次回拉
     * 把它当成「云端还没有的新数据」重新拉回来（或被本地水位的另一端判成冲突）。
     * 墓碑的 `updatedAt` 取当前时刻 —— 必须比备份里的一切都新，否则云端合并时
     * 会判本地旧、又把它复活回去。
     *
     * @param {{create?: Object, update?: Object, remove?: Object}} plan
     * @returns {Promise<{created: number, updated: number, removed: number}>}
     */
    async apply({ create = {}, update = {}, remove = {} } = {}) {
      await ready()
      const result = { created: 0, updated: 0, removed: 0 }
      const entries = []
      /** 同一批导入共用一个时刻：队列里这一批改动的时间戳一致，语义更清楚 */
      const ts = now()

      for (const [collection, storeName] of Object.entries(STORE_OF)) {
        const key = BACKUP_KEY_OF[collection]
        const created = create[key] || []
        const updated = update[key] || []
        const removeIds = remove[key] || []

        const docs = [...created, ...updated].map((doc) => toPlain({ ...doc, deleted: 0 }))
        if (docs.length) {
          await putMany(storeName, docs)
          for (const doc of docs) {
            entries.push({
              id: uid('ob'),
              collection,
              op: 'update',
              docId: doc.id,
              payload: { ...doc },
              ts
            })
          }
          result.created += created.length
          result.updated += updated.length
        }

        if (removeIds.length) {
          const wanted = new Set(removeIds)
          const tombstones = (await readAll(storeName))
            .filter((doc) => wanted.has(doc.id) && alive(doc))
            .map((doc) => toPlain({ ...doc, deleted: 1, updatedAt: ts }))

          if (tombstones.length) {
            await putMany(storeName, tombstones)
            for (const doc of tombstones) {
              entries.push({
                id: uid('ob'),
                collection,
                op: 'delete',
                docId: doc.id,
                payload: { ...doc },
                ts
              })
            }
            result.removed += tombstones.length
          }
        }
      }

      // 合成一次写、一次通知（理由见 outbox.enqueueMany 的注释）
      try {
        await outbox.enqueueMany(entries)
      } catch (e) {
        // 与 enqueue() 同一条底线：数据已经落库了，队列晚一轮是小事，丢数据是大事
        console.error('[ledger] 导入数据的同步队列写入失败，这批改动本轮不会上云', e)
      }
      return result
    }
  }

  /* ---------------- 同步 ---------------- */

  /**
   * 队列状态查询。真正的推送/拉取在 sync/syncEngine.js ——
   * 适配器只负责「写的时候把改动放进队列」。
   */
  const syncApi = {
    async pendingCount() {
      return outbox.pendingCount()
    },
    /** 仅调试用 */
    async clearOutbox() {
      await outbox.clear()
      return true
    }
  }

  /** 集合名 → objectStore 名 */
  const STORE_OF = {
    [COLLECTIONS.LEDGER]: STORES.LEDGER,
    [COLLECTIONS.CATEGORY]: STORES.CATEGORY,
    [COLLECTIONS.BILL]: STORES.BILL
  }

  /**
   * 集合名 → 备份文件里的键名。
   *
   * ⚠️ 备份格式用**复数**（`ledgers` / `categories` / `bills`）而集合名是单数：
   *    备份是给人看、可能被转发与二次处理的文件，「三个账单数组」比
   *    「bill / category / ledger 混排」更自然；也避免与集合名耦合成
   *    「改集合名就换备份格式」。
   */
  const BACKUP_KEY_OF = {
    [COLLECTIONS.LEDGER]: 'ledgers',
    [COLLECTIONS.CATEGORY]: 'categories',
    [COLLECTIONS.BILL]: 'bills'
  }

  /**
   * 给 syncEngine 用的本地读写口（不挂在契约上，也不属于视图层的依赖）。
   * 引擎只知道「读一条文档」「把远端增量写回本地」，不关心底层是 IndexedDB。
   */
  const syncStore = {
    async get(collection, id) {
      await ready()
      const name = STORE_OF[collection]
      if (!name) return null
      return readOne(name, id)
    },

    /** 读某个集合的全部本地文档。首次绑定要把它们整体入队推上云 */
    async all(collection) {
      await ready()
      const name = STORE_OF[collection]
      if (!name) return []
      return readAll(name)
    },

    /**
     * 把远端增量合并进本地。
     * `clockOffset`（S4-2）= 服务端时间 - 本地时间，用来把两边的 `updatedAt`
     * 换算到服务端时间轴上比较。引擎只在服务端时间可信时才传非 0 值。
     */
    async applyRemote(collection, docs, clockOffset = 0) {
      await ready()
      const name = STORE_OF[collection]
      if (!name || !docs || !docs.length) return { applied: 0, kept: 0 }
      const locals = await readAll(name)
      // 新者胜：远端更新才覆盖，本地更新的保留（它还在 outbox 里等下一轮推送）
      const { take, keep } = partitionRemote(locals, docs, clockOffset)
      if (take.length) await putMany(name, take)
      return { applied: take.length, kept: keep.length }
    },

    /**
     * 把服务端盖的裁决刻度写回本地副本（S4-6）。
     *
     * `stamps`：`{ [本地id]: 服务端刻度 }`。只更新 `serverUpdatedAt` 一个字段。
     *
     * ⚠️ **不走写路径、不入 outbox**：这是服务端元数据，不是用户内容。
     *    入队会自己推自己，而且刻度只能由服务端生成，推上去也会被覆盖。
     *    `updatedAt` 也**不动** —— 那是内容版本（客户端时钟），保持原样。
     *
     * ⚠️ 文档可能已被本地再次修改（`updatedAt` 晚于刻度）—— 那没关系，
     *    写入后 `effectiveServerStamp` 会判定该刻度失效并退回 `updatedAt`，
     *    不会把新内容误判成旧内容。这里不做判断，判断只留在裁决那一处。
     *
     * 写入前 `toPlain()`：结构化克隆处理不了 Vue 的 Proxy（见本文件上方说明）。
     */
    async applyStamps(collection, stamps) {
      await ready()
      const name = STORE_OF[collection]
      if (!name || !stamps) return 0
      const ids = Object.keys(stamps)
      if (!ids.length) return 0
      const existing = await readAll(name)
      const byId = new Map(existing.map((d) => [d.id, d]))
      const next = []
      for (const id of ids) {
        const doc = byId.get(id)
        if (!doc) continue
        const stamp = Number(stamps[id])
        if (!Number.isFinite(stamp) || stamp <= 0) continue
        next.push({ ...doc, serverUpdatedAt: stamp })
      }
      if (next.length) await putMany(name, next)
      return next.length
    }
  }

  return {
    name: 'idb',
    /** 实际使用的库名（S5-5：可能是分区库 `ledger_<前缀>`）。UI 与排查用它 */
    dbName,
    ledger: ledgerApi,
    category: categoryApi,
    bill: billApi,
    sync: syncApi,
    /** 数据备份读写口（S8-1）：dump 原始快照 / apply 落盘导入计划 */
    backup: backupApi,
    /** 同步队列实例（syncEngine 与调试面板用） */
    outbox,
    /** 给 syncEngine 的本地读写口 */
    syncStore,
    /** 键值仓（syncEngine 存水位线用） */
    kv,
    /** 建库 + 接管/播种 + 迁移（切换数据源后可显式 await，确认一切就绪） */
    ready,

    /**
     * 把本分区**全部本地文档**整体入队一次（S7-7）。
     *
     * ## 什么时候用
     *
     * 登录成功、切到账号分区之后。那个分区刚播了基础设施（账本 + 默认分类），
     * 它们是 `putMany` 直写的，**没进 outbox**。不补这一步，全新账号的默认分类
     * 就永远上不了云 —— 换设备登录会看到空宫格。
     *
     * ## 幂等
     *
     * 靠 meta 标记 `localPushedToCloud`：每个分区只跑一次。没有它的话，
     * 每次登录都要重新入队几百条，同步会白跑一堆注定被云端拒掉的推送
     * （云端那份更新，LWW 会拒绝）。
     *
     * @returns {Promise<number>} 入队的文档条数；已做过则 0
     */
    async enqueueAll() {
      await ready()
      const meta = await readMeta()
      if (meta[META_KEYS.LOCAL_PUSHED]) return 0

      let queued = 0
      for (const [collection, storeName] of Object.entries(STORE_OF)) {
        const docs = await readAll(storeName)
        for (const doc of docs) {
          await enqueue(collection, 'create', doc.id, { ...doc })
          queued += 1
        }
      }
      await writeMeta({ [META_KEYS.LOCAL_PUSHED]: now() })
      return queued
    },

    /** 仅调试用：清空 IndexedDB 并重新播种（「我的 → 重置演示数据」） */
    async reset() {
      await getDB()
      const meta = await readMeta()

      // 保留两个「已经导入过了」的标记：重置应该得到干净的演示数据，
      // 而不是把 localStorage 里的旧数据（旧库 / 旧队列）又导入一遍
      const kept = {}
      ;[META_KEYS.IMPORTED, META_KEYS.OUTBOX_IMPORTED].forEach((key) => {
        if (meta[key]) kept[key] = meta[key]
      })

      await clearStore(STORES.LEDGER)
      await clearStore(STORES.CATEGORY)
      await clearStore(STORES.BILL)
      await clearStore(STORES.META)
      await outbox.clear()

      if (Object.keys(kept).length) await writeMeta(kept)
      // 开发构建下「重置演示数据」要的是**完整的**演示数据，即使当前分区
      // 平时只播基础设施（`'base'`）。生产构建不抬档 —— 按钮在那里不出现。
      pendingResetMode = IS_DEV ? SEED_MODE.FULL : seedMode
      initPromise = null
      await ready()
      pendingResetMode = null
      return true
    },

    /**
     * 清空业务数据 + 同步水位线。**故意不复用 `reset()`**：
     * reset 是「重置演示数据」，清完会重新播种；这里要的是**干净的空库**。
     *
     * 两个使用场景：
     *   - S5-4 退出登录：改动已全部推上云 → 本地这份副本按约定清掉；
     *   - S5-7 首绑裁决选「保留云端」：舍弃本地内容，让云端成为唯一真相。
     *
     * 保留什么（**都别清，清了会出怪事**）：
     *   - `schemaVersion` —— 清了下次开库会重新播种，等于把「空库」又灌成演示数据；
     *   - `importedFromLocalStorage` / `outboxImported` —— 清了会把 localStorage 的
     *     旧库/旧队列再导入一遍；
     *   - `seedMeta` / `firstBindDone` —— 让这个分区记住「自己已经是什么状态」。
     * 清掉什么：
     *   - 三个业务集合、同步队列；
     *   - **`syncWatermark`** —— 必须清！留着的话下次登录是增量拉取，
     *     而云端文档的 `_serverTs` 都早于水位，一条都拉不回来，
     *     用户会看到一个**空账号**（数据其实还在云端）。
     */
    async clearLocalData() {
      await getDB()
      const meta = await readMeta()
      const kept = {}
      Object.entries(meta).forEach(([key, value]) => {
        if (key !== META_KEYS.WATERMARK) kept[key] = value
      })

      await clearStore(STORES.LEDGER)
      await clearStore(STORES.CATEGORY)
      await clearStore(STORES.BILL)
      await clearStore(STORES.META)
      await outbox.clear()
      if (Object.keys(kept).length) await writeMeta(kept)
      // ⚠️ 不碰 initPromise：这里要的是「空库保持空」，不是重新走一遍建库播种
      return true
    },

    /**
     * 注销账号时的本地清除（**不可逆**）：把这个分区清回「从未使用过」。
     *
     * ## 与 `clearLocalData()`（退出登录用）的区别
     *
     * | | `clearLocalData()` | `deleteLocalData()` |
     * | --- | --- | --- |
     * | 清四个业务表 + 队列 | ✅ | ✅ |
     * | 抹掉 meta（建库标记 / 水位线 / 导入标记） | ❌（只清水位线） | ✅ |
     * | 清第一阶段遗留的 localStorage 键 | ❌ | ✅ |
     * | 谁用 | 退出登录（分区稍后会被同一账号复用） | 注销账号（分区要回到出厂态） |
     *
     * 注销必须比退出更彻底：库里留着 `schemaVersion` 的话，同一个手机号再登录时
     * `init()` 会认为「这个库已经初始化过」而**跳过播种**，用户看到一片空宫格
     * （S7 真机踩过的同款症状；`partition-test` 第 16 节把这对差别钉死了）。
     *
     * ## 为什么是「清空 + 抹标记」而不是 `indexedDB.deleteDatabase`
     *
     * 删库看着更干净，实测行不通（2026-10-02，fake-indexeddb 复现，与规范一致）：
     * 还有别的连接（另一个标签页）开着时，`deleteDatabase()` 不会失败，而是进入
     * `blocked` 被**永久挂起**；此后连 `open()` 同一个库都会排到那个挂起的删除
     * 请求**后面** —— 「删不掉就退回去清表」这条兜底路径会自己把自己锁死。
     * 而「清空表 + 抹掉 meta + 清遗留键」在行为上与删库**完全等价**：
     * 数据没了、标记没了、`init()` 会重新播种，且不会留下任何挂起请求。
     *
     * ## 三步缺一不可
     *
     *   ① 清四个业务表 + 队列；
     *   ② 清第一阶段遗留的两个 localStorage 键 —— 抹掉 meta 之后 `init()` 会
     *      重新走 `readLegacy()`，不清这两个键等于**注销完数据又复活**；
     *   ③ `initPromise = null` —— 让下一次 `ready()` 真的重跑 `init()`。
     *      少了这一步，这个实例在本会话里永远停在「已初始化」，同号再登录时
     *      不会再播种（`bucketCache` 会把同一个实例还回来）。
     *
     * @returns {Promise<boolean>} 恒为 true
     */
    async deleteLocalData() {
      await getDB()
      for (const storeName of [STORES.LEDGER, STORES.CATEGORY, STORES.BILL, STORES.META]) {
        await clearStore(storeName)
      }
      await outbox.clear()

      idbClearLegacyLocalKeys()

      initPromise = null
      pendingResetMode = null
      return true
    },

    /** 仅调试用：读出全部数据（结构对齐 mockAdapter.snapshot） */
    async snapshot() {
      await ready()
      const meta = await readMeta()
      return {
        schemaVersion: SCHEMA_VERSION,
        ledgers: await readAll(STORES.LEDGER),
        categories: await readAll(STORES.CATEGORY),
        bills: await readAll(STORES.BILL),
        meta: meta[META_KEYS.SEED] || {}
      }
    }
  }
}
