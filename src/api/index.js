/**
 * 数据层装配入口
 * ------------------------------------------------------------
 * 视图与 store 只依赖这里导出的 repository，不关心底层实现。
 *
 * ## S5-5 起：库按账号分区
 *
 * 以前这里是一行静态装配（`export const db = createIdbAdapter(...)`）。
 * S5-5 要求「一台设备上换账号不能串数据」，而串号的根源在**本地**：
 * 两个账号共用同一个 IndexedDB 库时，A 残留的 outbox 条目会被下一轮同步
 * 推到 **B 的名下**（云端 `_openid` 是 B 的）。数据本身有 `_openid` 隔离，
 * 但本地队列没有身份概念 —— 所以必须把库拆开：`ledger_<账号前缀>`。
 *
 * 于是装配变成**三步**，且中间一步是异步的（要先问云端「我是谁」）：
 *   ① 取身份（cloud.getIdentity / ensureSignedIn）
 *   ② 按 `accountPrefixOf(uid)` 选库名
 *   ③ 建适配器 → 建 outbox/kv → 建 syncEngine
 *
 * 问题在于 **ESM 的 `import` 是静态的**：store 里写死的
 * `import { billRepo } from '@/api'` 拿到的绑定在模块求值时就已经存在，
 * 没法等异步身份确定后再赋一个真正的对象进去。
 *
 * 解法：对外的 `db` / `ledgerRepo` / `categoryRepo` / `billRepo` / `syncEngine`
 * 全部是**稳定代理**，内部指向「当前那一套实例」；`rebuildForAccount()`
 * 只替换内部指针，代理对象本身永不改变。视图与 store 因此**零改动**。
 *
 * 这样一来三条纪律仍然成立：
 *   - 视图层不碰 adapter（拿到的还是 repository 接口）；
 *   - 后端可替换（换云端只改这里的 cloud 那一处）；
 *   - 写操作 local-first（代理转发到当前 outbox）。
 */
import { createMockAdapter } from './adapters/mockAdapter.js'
import { createIdbAdapter } from './adapters/idbAdapter.js'
import { createCloudBaseAdapter } from './adapters/cloudbaseAdapter.js'
import { createSyncEngine } from './sync/syncEngine.js'
import { GUEST_ACCOUNT_PREFIX, accountPrefixOf } from './core/cloudId.js'
import { DB_NAME, partitionedDbName } from './core/idb.js'
import { BACKUP_COLLECTIONS, buildBackup, parseBackup, planImport, planRestore } from './core/backup.js'
import { RepositoryError } from './contract.js'
import { cloudEnvId, isCloudConfigured } from '../config/env.js'

const ADAPTERS = {
  mock: createMockAdapter,
  idb: createIdbAdapter
}

/**
 * 当前数据源：mock | idb
 * 第二阶段已切到 idb（IndexedDB）：数据真正落在本机数据库里，刷新/重启不丢，
 * 同步队列（outbox）也搬进了同一个库。切回 mock 只需改这一行。
 */
export const DATA_SOURCE = 'idb'

/**
 * 是否启用「按账号分区库名」（S5-5）。
 *
 * 关掉它 = 退回 S5 之前的单库行为。留着这个开关是为了**可回退**：
 * 分区逻辑一旦有问题，改这一个常量就能回到老路径，不用改代码。
 * mock 数据源不分区（它连库都没有）。
 */
export const PARTITION_DB_BY_ACCOUNT = DATA_SOURCE === 'idb'

/**
 * 云端客户端（第二阶段 S3）
 *
 * 没配 `.env.local` 里的 `VITE_CLOUDBASE_ENV` 时是 `null` —— 同步引擎会直接跳过
 * （返回 `{ ok: false, skipped: true, reason: 'no-cloud' }`），应用照常本地记账，
 * 不白屏、不报错。配了就换成真实的 CloudBase 适配器。
 *
 * ⚠️ 它是**单例**、不随后端库分区而重建：登录态与账号前缀都在它内部维护，
 *    重建会让「刚刚登录好的 uid」丢掉。
 */
export const cloud = isCloudConfigured ? createCloudBaseAdapter({ env: cloudEnvId }) : null

/* ---------------- 当前实例（可替换的内部指针） ---------------- */

/** 当前这「一套」数据层：适配器 + 引擎。代理都指向它 */
let current = null

/** 库名 → 已建好的那套实例。分区分块之后重复切账号不该重复建引擎 */
const bucketCache = new Map()

/**
 * 由 uid 决定库名。
 *
 * 拿不到 uid 时用**未登录分区**（`ledger_guest`）而不是裸 `ledger`：
 *   裸库是 S5 之前所有数据的老家，继续往里写会让「老数据」与「未登录数据」
 *   混在一起，日后无法区分该继承给谁。`ledger_guest` 是一个明确的、
 *   表示「这台设备还没登录」的分区。
 *
 * ⚠️ S7-2 之前它叫 `ledger_anon`（匿名分区）。改名是**有意的**：匿名身份已经
 *    不存在了，那个库不会再被读取（旧数据留在盘上，不做迁移）。
 */
function dbNameFor(uid) {
  if (!PARTITION_DB_BY_ACCOUNT) return DB_NAME
  return partitionedDbName(accountPrefixOf(uid) || GUEST_ACCOUNT_PREFIX)
}

/**
 * 造一套实例。[dbName 相同则复用缓存] —— 切回上一个账号时不必重建引擎。
 *
 * 两类分区在选项上**差别很大**，见下面逐项注释：
 *
 * | | `ledger_guest`（未登录） | `ledger_<账号前缀>`（已登录） |
 * | --- | --- | --- |
 * | 播种 | **只播基础设施**（`'base'`） | **只播基础设施** |
 * | 分类时间戳 | 正常 | **0**（默认值，永远输给云端真实数据） |
 * | 继承旧裸库 | **不继承** | **不继承**（S7-10 起，见下） |
 *
 * ## S7-10：账号分区也不继承裸库
 *
 * 原设计（S5-5）让**第一个**登录的账号认领裸库 `ledger`，把第一阶段的老数据
 * 顺过来。真机实测（2026-10-02）发现这条路会**击穿 S7**：
 *
 *   裸库 `ledger` 是 S5 之前的「未分区老家」，里面躺着一整套**演示账单**
 *   （44 条，¥8720.72）。账号分区一旦继承它，`enqueueLocalForCloud()` 会把
 *   继承来的文档**整体入队**，下一轮同步就推到真实账号名下 ——
 *   新账号凭空多出演示账，正是 S7「全新账号 0 账单」要防的事。
 *
 * 于是这里传 `false`：**登录后只信云端**（拉取覆盖本地），放弃老库自动迁移。
 * 代价是「第一阶段的老用户不会自动带走老数据」—— 但那条路径从来没有真实
 * 用户走过，而污染路径是**真机上复现过的**，两害相权取轻。
 *
 * ⚠️ 适配器仍保留 `migrateFrom` / `claimant` 能力（`partition-test` 第 7/10/11
 *    节照旧覆盖），只是**装配层不再使用**——将来若要恢复迁移，改这一行即可。
 */
function buildInstance(dbName) {
  if (bucketCache.has(dbName)) return bucketCache.get(dbName)

  const isGuest = dbName === partitionedDbName(GUEST_ACCOUNT_PREFIX)

  const options =
    DATA_SOURCE === 'mock'
      ? { latency: 24 }
      : {
          dbName,
          /**
           * 播种档位（S7-9 三态：`'base'` / `'full'` / `false`）。
           *
           * **所有分区常规启动都只播基础设施**（账本 + 分类齐备，金额 0.00）——
           * 包括未登录分区。演示账单只出现在两个地方：开发构建的
           * 「重置演示数据」按钮（显式抬档 `'full'`），以及历史遗留的分区库
           * （下面的 `purgeSeedBills` 负责清一次）。
           * 账号分区更是必须如此：新账号凭空多出 ¥8720.72 就是
           * 「演示账单被种子推上云」这条链污染上去的。
           */
          seed: 'base',
          /**
           * 账号分区兜底播种的分类 `updatedAt = 0`：语义是「这是默认值，
           * 优先级最低」。云端已有同名 id 的分类（用户改过名字/图标）时，
           * 冲突裁决「新者胜」会让**云端赢**，本地默认值静默让位；
           * 云端没有（全新账号）时，这份默认分类被推上去，换设备也带得走。
           */
          seedCategoryUpdatedAt: isGuest ? null : 0,
          /**
           * 未登录分区的一次性清理（S7-9 补丁）：guest 只播 `'base'` 之前，
           * 更早的开发构建已经往 guest 分区灌过整套演示账单 —— 未登录
           * 写不了账单，guest 库里的账单只可能来自种子，清掉是安全的。
           */
          purgeSeedBills: isGuest,
          /**
           * 继承旧裸库（S5-5）：**装配层一律关闭**（S7-10）。
           *
           * 曾经只有账号分区认领裸库（`partitioned && !isGuest`）。真机实测
           * 证实那条路会把裸库里遗留的**演示账单**整批入队推上真实账号
           * （详见文件头「S7-10」）。现在登录后只信云端：新分区只播
           * 基础设施，数据由同步引擎从云端拉齐。
           *
           * ⚠️ 想恢复老库迁移只需把它改回 `partitioned && !isGuest ? DB_NAME : false`
           *    （并同时把 `claimant` 传回去）。
           */
          migrateFrom: false
        }

  const db = ADAPTERS[DATA_SOURCE](options)

  const syncEngine = createSyncEngine({
    /** 待推队列 —— 适配器写操作时往里投递 */
    outbox: db.outbox,
    /** 本地读写口 —— 引擎只认「读一条 / 写一批 / 读全量」，不碰 IndexedDB 细节 */
    store: db.syncStore,
    /** 键值仓（存水位线）。mock 数据源没有持久化，传 null 即可 */
    meta: db.kv || null,
    cloud
  })

  const instance = { db, dbName, syncEngine }
  bucketCache.set(dbName, instance)
  return instance
}

const repoProxy = (name) =>
  new Proxy(
    {},
    {
      get(_, prop) {
        const target = current?.db?.[name]
        if (!target) return undefined
        const value = target[prop]
        return typeof value === 'function' ? value.bind(target) : value
      },
      has(_, prop) {
        const target = current?.db?.[name]
        return Boolean(target && prop in target)
      }
    }
  )

/**
 * 对外暴露的 repository 代理。
 * 用 Proxy 而不是「每次调用时查一遍」的包装函数：`billRepo.list()` 这类
 * 调用点一个都不用改，`typeof billRepo.list === 'function'` 也照样成立。
 */
export const ledgerRepo = repoProxy('ledger')
export const categoryRepo = repoProxy('category')
export const billRepo = repoProxy('bill')

/** 适配器代理（`db.ready()` / `db.reset()` / `db.snapshot()` 等调试入口） */
export const db = new Proxy(
  {},
  {
    get(_, prop) {
      const target = current?.db
      if (!target) return undefined
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
    has(_, prop) {
      return Boolean(current?.db && prop in current.db)
    }
  }
)

/** 同步引擎代理（订阅 / 手动同步 / 状态读取）。引擎会被替换，代理不变 */
export const syncEngine = new Proxy(
  {},
  {
    get(_, prop) {
      const target = current?.syncEngine
      if (!target) return undefined
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
    has(_, prop) {
      return Boolean(current?.syncEngine && prop in current.syncEngine)
    }
  }
)

/* ---------------- 生命周期 ---------------- */

/**
 * 切换到某个账号的数据分区。
 *
 * 登录 / 转正 / 登出之后**必须**调它，否则新账号会读着上一个账号的库。
 *
 * 做三件事：
 *   ① 停掉旧引擎（清掉防抖与退避定时器、解绑 online/offline 与 outbox 订阅）——
 *      不停的话旧引擎醒来会把**旧账号的队列**推出去，正是要防的串号；
 *   ② 换内部指针到新分区；
 *   ③ 返回新引擎（调用方决定是否 `start()`）。
 *
 * ⚠️ **不清空 bucketCache**：同一个账号切回来时应复用原来的引擎与队列，
 *    重建会把「还没推上去的本地改动」留在库里、却丢掉内存里的重试计数与水位。
 *
 * @param {string|null} uid 目标账号 uid（null = 未登录分区）
 * @returns {{ dbName: string, changed: boolean, syncEngine: object }}
 */
export function rebuildForAccount(uid) {
  const dbName = dbNameFor(uid)
  if (current && current.dbName === dbName) {
    return { dbName, changed: false, syncEngine: current.syncEngine }
  }

  // ① 停旧引擎。stop() 是幂等的，重复调没问题
  if (current?.syncEngine?.stop) current.syncEngine.stop()

  // ② 换指针
  current = buildInstance(dbName)

  // ③ 让调用方去 start（重建时不该偷偷开始同步：可能还没有登录态）
  return { dbName, changed: true, syncEngine: current.syncEngine }
}

/** 当前分区库名（UI 与排查用） */
export function currentDbName() {
  return current?.dbName || null
}

/** 当前这一套实例的原始引用（**仅测试与调试**，业务代码不要用） */
export function currentInstance() {
  return current
}

/**
 * 初始化：确定「我是谁」→ 选库 → 建实例。
 *
 * 身份获取的优先级：
 *   1. 已经登录过的会话（`cloud.getIdentity()`，**不会**新建任何账号）——
 *      这样「上次用手机号登录过」的用户一进来就落在自己那个分区，
 *      而不是先在别处建一个分区、再切走；
 *   2. 没有云端（未配置）→ 用未登录分区（纯本地记账）；
 *   3. 有云端但还没登录 → 落到未登录分区 `ledger_guest`；登录时再 `rebuildForAccount`。
 *
 * ⚠️ **启动时绝不创建账号**。S7 去掉了匿名身份，`ensureSignedIn()` 也只会
 *    「复用已存在的登录态」、拿不到就抛 `NOT_SIGNED_IN`。所以未登录就是
 *    老老实实待在 `ledger_guest` 分区 —— 那里有账本和分类（能看能算），
 *    只是不能写：写操作会被 UI 的登录门禁拦住（见 `composables/useLoginGate.js`）。
 */
export async function initDataLayer() {
  if (current) return current
  let uid = null
  if (cloud?.getIdentity) {
    try {
      const id = await cloud.getIdentity()
      uid = id?.uid || null
    } catch (e) {
      uid = null
    }
  }
  rebuildForAccount(uid)
  return current
}

/* ---------------- 账号切换的收尾 ---------------- */

/**
 * 把本分区**已有的本地文档**整体入队，等下一轮同步推上云（S7-7）。
 *
 * ## 为什么需要它（原本是首绑裁决里的一半）
 *
 * 登录之后的账号分区里，本地会先播一份**基础设施**
 * （账本 + 默认分类，见 S7-9）。那些文档是适配器直接写进库的，
 * **没有经过写路径**，所以不在 outbox 里。不把它们入队，一个全新账号
 * 的默认分类就**永远上不了云** —— 「换设备用手机号登录，分类还是齐的」
 * 这件事就不成立。
 *
 * S5-7 时期这件事由首绑裁决的 `push-local` 分支顺带做了；
 * S7 删掉裁决之后（匿名身份没了，云端不可能有「别人的」数据要防），
 * 只留下这个动作本身。
 *
 * ⚠️ **幂等由适配器保证**（每个分区只做一次，靠 meta 标记）：
 *    否则每次登录都把几百条文档重新入队，同步会白跑
 *    一堆注定被拒的推送。
 *
 * @returns {Promise<number>} 本次入队的文档条数（已做过则返回 0）
 */
export async function enqueueLocalForCloud() {
  if (!cloud) return 0
  const inst = current || (await initDataLayer())
  if (typeof inst.db.enqueueAll !== 'function') return 0
  return inst.db.enqueueAll()
}

/* ---------------- 数据备份（S8-1） ---------------- */

/**
 * 导出：把当前分区**用户可见的全部数据**打包成一个可 JSON 序列化的对象。
 *
 * ## 为什么它放在装配层而不是视图里
 *
 * 「导出」= 一次读全量 + 一次按格式打包。读全量要知道**当前分区**是谁
 * （`current` 指针在装配层维护），而打包规则属于业务（在 `core/backup.js`）。
 * 装配层的作用就是把这两件事接起来 —— 视图只负责「把返回的对象存成文件」。
 *
 * ⚠️ **导出是读操作，不设登录门禁**。未登录时导出拿到的是本机 guest 分区
 *   （只有账本与分类、没有账单），调用方据此提示「暂无可导出的记录」即可，
 *   不必拦 —— 拦了反而说不通（数据本来就在用户自己的设备上）。
 *
 * @param {{account?: {label?:string, signedIn?:boolean}|null, exportedAt?: number}} [input]
 * @returns {Promise<Object>} 备份对象（交给 `JSON.stringify`）
 */
export async function exportBackup({ account = null, exportedAt = Date.now() } = {}) {
  const inst = current || (await initDataLayer())
  if (!inst?.db?.backup) throw new RepositoryError('NO_BACKUP', '当前数据源不支持数据导出')
  const dump = await inst.db.backup.dump()
  return buildBackup({ data: dump, account, exportedAt, dataSource: DATA_SOURCE })
}

/**
 * 预览导入：解析文件 + **同时**算出两份计划，**不写任何东西**。
 *
 * 中间隔一层预览不是仪式感 —— 导入是**批量写**，恢复模式下还会删数据，且都会
 * 入队推上云。先让用户看到「会变成什么样」再确认，是这类操作的底线。
 *
 * 返回两份计划，因为它们是两种语义（详见 `core/backup.js` 决定 ②），
 * 界面上对应两个按钮：
 *   - `plan`    —— **合并**：只新增 / 覆盖，绝不删本机已有数据。默认、安全。
 *   - `restore` —— **恢复**：以备份为准完整还原（含删除本机多出的、复活已删的）。
 *
 * @param {string|Object} text 备份文件文本（或已解析对象）
 * @returns {Promise<{ok:false, error:string} |
 *   {ok:true, backup:Object, invalid:Object, plan:Object, restore:Object}>}
 */
export async function previewImport(text) {
  const parsed = parseBackup(text)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  const inst = current || (await initDataLayer())
  if (!inst?.db?.backup) return { ok: false, error: '当前数据源不支持数据导入' }

  const local = await inst.db.backup.dump()
  const incoming = parsed.backup.data
  return {
    ok: true,
    backup: parsed.backup,
    invalid: parsed.invalid,
    plan: planImport({ local, incoming }),
    restore: planRestore({ local, incoming })
  }
}

/**
 * 落盘导入。
 *
 * ⚠️ **写前用最新本地副本重算一次计划**：预览与确认之间隔着用户点击（恢复模式
 * 还多一层二次确认），期间同步引擎可能已经把云端更新的版本拉了回来。若照预览
 * 时的计划直写，就会用备份里的旧版本盖掉刚拉回来的新数据。
 *
 * 复用 `core/` 里的两个 planner 而不是新写一套「再检查」逻辑：规则只有一份实现，
 * 才不会出现「预览时说会更新、落盘时又按另一套规则」这种漂移。
 *
 * ⚠️ 入参是**备份数据本身**（`preview.backup.data`），不是预览时的计划 ——
 * 恢复模式需要看到备份的**全量**（含合并口径下被跳过的那些），
 * 只传计划会把它们漏掉。
 *
 * @param {{mode?: 'merge'|'restore', data?: Object}} input
 *   `data` 形状为 `{ ledgers, categories, bills }`
 * @returns {Promise<{created:number, updated:number, removed:number, skipped:number, mode:string}>}
 */
export async function applyImport({ mode = 'merge', data = {} } = {}) {
  const inst = current || (await initDataLayer())
  if (!inst?.db?.backup) throw new RepositoryError('NO_BACKUP', '当前数据源不支持数据导入')

  const incoming = {}
  for (const kind of BACKUP_COLLECTIONS) {
    incoming[kind] = data?.[kind] || []
  }

  const fresh = await inst.db.backup.dump()
  const safe =
    mode === 'restore'
      ? planRestore({ local: fresh, incoming })
      : planImport({ local: fresh, incoming })

  const result = await inst.db.backup.apply(safe)
  return { ...result, skipped: safe.counts.skip, mode }
}

export { COLLECTIONS, BILL_TYPES, CATEGORY_TYPES, NAME_MAX_LENGTH } from './contract.js'
export { backupFileName, BACKUP_FORMAT, BACKUP_VERSION } from './core/backup.js'
export { NotImplementedError, RepositoryError, SCHEMA_VERSION } from './contract.js'
export { accountPrefixOf } from './core/cloudId.js'
