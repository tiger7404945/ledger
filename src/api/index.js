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
import { accountPrefixOf } from './core/cloudId.js'
import {
  ensureFirstBind,
  resolveFirstBind as resolveFirstBindChoice,
  readPendingFirstBind,
  cloudHasData
} from './core/firstBind.js'
import { DB_NAME, DB_PARTITION_PREFIX, isPartitionedDbName, partitionedDbName } from './core/idb.js'
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
 * 拿不到 uid 时用**未认证分区**（`ledger_anon`）而不是裸 `ledger`：
 *   裸库是 S5 之前所有数据的老家，继续往里写会让「老数据」与「新匿名数据」
 *   混在一起，日后无法区分该继承给谁。`ledger_anon` 是一个明确的、
 *   表示「还没身份」的分区。
 */
function dbNameFor(uid) {
  if (!PARTITION_DB_BY_ACCOUNT) return DB_NAME
  return partitionedDbName(accountPrefixOf(uid) || 'anon')
}

/**
 * 造一套实例。[dbName 相同则复用缓存] —— 切回上一个账号时不必重建引擎。
 *
 * `migrateFrom`：分区库第一次进来时从旧裸库继承数据（见 core/idb.js）。
 * 只在「分区库 + 不是裸库本身」时传，避免自搬自。
 *
 * `claimant`：本分区的认领标识（账号前缀）。裸库只会被**第一个**分区认领，
 * 之后再登录的别的账号不会继承到同一份数据 —— 防跨账号串号（见 core/idb.js）。
 * 未认证分区（`ledger_anon`）也带自己的认领标识：它同样是一个明确的身份。
 */
function buildInstance(dbName) {
  if (bucketCache.has(dbName)) return bucketCache.get(dbName)

  const options =
    DATA_SOURCE === 'mock'
      ? { latency: 24 }
      : {
          dbName,
          // 分区库首次进入时继承旧裸库的数据——否则用户会以为账全丢了
          migrateFrom: isPartitionedDbName(dbName) ? DB_NAME : false,
          // 认领标识 = 库名去掉前缀，与库名一一对应
          claimant: isPartitionedDbName(dbName) ? dbName.slice(DB_PARTITION_PREFIX.length) : ''
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
 *   1. 已经登录过的会话（`cloud.getIdentity()`，**不会**新建匿名账号）——
 *      这样「上次用手机号登录过」的用户一进来就落在自己那个分区，
 *      而不是先匿名建一个分区、再切走；
 *   2. 没有云端（未配置）→ 用未认证分区；
 *   3. 有云端但还没登录 → 先落到未认证分区；后续登录/转正时再 `rebuildForAccount`。
 *
 * ⚠️ **刻意不在启动时调 `ensureSignedIn()`**（那会创建匿名账号）。
 *    启动即匿名的老行为在 S5 要改：先看有没有真身份。真正需要数据方法时
 *    适配器自己会 `ensureSignedIn` 兜底。
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

/* ---------------- 首次绑定（S5-7：先问用户，不再无脑本地优先） ---------------- */

/**
 * 首次绑定判定。**实现已搬到 `core/firstBind.js`**（纯逻辑 + 依赖注入，可在 Node 里测），
 * 这里只负责把「当前分区」的 db 与云端递进去。
 *
 * 返回值见 core/firstBind.js：
 *   - `{ ok:true, queued }`                                  已按本地优先入队
 *   - `{ ok:false, skipped:true, reason:'already-bound' | … }` 跳过
 *   - `{ ok:false, skipped:true, reason:'needs-decision', localCount }`
 *     —— **云端已有该账号的数据**，得先问用户「推本地」还是「留云端」。
 *     UI 拿到这个要**先别同步**，否则云端那份已经拉下来了，选择就名不副实。
 *
 * S3 时期这里是「本地优先」写死的，当时匿名身份下云端不可能有别人的数据；
 * 有了真账号之后云端**可能已经有数据**（换设备登录 / 重装后重绑），
 * 无脑本地优先会污染或覆盖人家的账，所以改成先裁决。
 */
export async function ensureCloudFirstBind() {
  if (!cloud) return { ok: false, skipped: true, reason: 'no-cloud' }
  const inst = current || (await initDataLayer())
  return ensureFirstBind({ db: inst.db, cloud })
}

/**
 * 执行首绑裁决，并立刻同步一次（两条路都得同步才有意义）：
 *   - `'push-local'` → 本地已整体入队，同步把改动推上去；
 *   - `'keep-cloud'` → 本地已清空 + 水位已清，同步全量回拉云端数据。
 */
export async function resolveFirstBind(choice) {
  const inst = current || (await initDataLayer())
  const res = await resolveFirstBindChoice({ choice, db: inst.db })
  const sync = await syncEngine
    .sync({
      reason: choice === 'keep-cloud' ? 'first-bind-cloud' : 'first-bind-local',
      manual: true
    })
    .catch(() => null)
  return { ...res, sync }
}

/** 探测云端当前账号是否已有数据（调试/排查用；正式判定在 core/firstBind.js 里） */
export { cloudHasData }

/** 读「待裁决的首绑」标记（UI 用来决定要不要弹框，见 core/firstBind.js 的说明） */
export async function pendingFirstBindInfo() {
  const inst = current || (await initDataLayer())
  return readPendingFirstBind({ db: inst.db })
}

export { COLLECTIONS, BILL_TYPES, CATEGORY_TYPES, NAME_MAX_LENGTH } from './contract.js'
export { NotImplementedError, RepositoryError, SCHEMA_VERSION } from './contract.js'
export { accountPrefixOf } from './core/cloudId.js'
