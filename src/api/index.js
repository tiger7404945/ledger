/**
 * 数据层装配入口
 * ------------------------------------------------------------
 * 视图与 store 只依赖这里导出的 repository，不关心底层实现。
 * 第二阶段切换本地缓存 / 云端同步时，只需改动 DATA_SOURCE 与 cloud。
 */
import { createMockAdapter } from './adapters/mockAdapter.js'
import { createIdbAdapter } from './adapters/idbAdapter.js'
import { createSyncEngine } from './sync/syncEngine.js'

const ADAPTERS = {
  mock: createMockAdapter,
  idb: createIdbAdapter
}

/** 各数据源的构造参数 */
const ADAPTER_OPTIONS = {
  mock: { latency: 24 },
  idb: { dbName: 'ledger' }
}

/**
 * 当前数据源：mock | idb
 * 第二阶段已切到 idb（IndexedDB）：数据真正落在本机数据库里，刷新/重启不丢，
 * 同步队列（outbox）也搬进了同一个库。切回 mock 只需改这一行。
 */
export const DATA_SOURCE = 'idb'

export const db = ADAPTERS[DATA_SOURCE](ADAPTER_OPTIONS[DATA_SOURCE])

export const ledgerRepo = db.ledger
export const categoryRepo = db.category
export const billRepo = db.bill

/**
 * 云端客户端（第二阶段 S3 注入）
 *
 * 目前是 null。同步引擎在 cloud 为空时会直接跳过 ——
 * 返回 `{ ok: false, skipped: true, reason: 'no-cloud' }`，状态保持 idle，
 * 应用照常可用（不白屏、不报错、不影响记账）。S0 做完配置后，这里改成
 * 「未配置就传 null」，S3 时换成真正的 cloudbaseAdapter：
 *
 *   import { createCloudBaseAdapter } from './adapters/cloudbaseAdapter.js'
 *   export const cloud = isCloudConfigured ? createCloudBaseAdapter({ env }) : null
 *
 * 它只需要实现 `sync/cloudClient.js` 里的三个方法（pull / push / serverTime），
 * syncEngine 一行都不用改。
 *
 * 注意：LeanCloud 已停服（2026-01 冻结注册、2027-01 关闭服务），
 * 选型经 Supabase 后最终定为腾讯云开发 CloudBase，详见 phase2-backend-plan.md。
 */
export const cloud = null

/**
 * 同步引擎（第二阶段 S2）
 *
 * 它自己不做网络，只做调度：什么时候同步、失败了怎么退避、被云端拒绝怎么办。
 * 启动入口在 `main.js`（`syncEngine.start()`）。
 */
export const syncEngine = createSyncEngine({
  /** 待推队列 —— 适配器写操作时往里投递 */
  outbox: db.outbox,
  /** 本地读写口 —— 引擎只认「读一条 / 写回一批」，不碰 IndexedDB 细节 */
  store: db.syncStore,
  /** 键值仓（存水位线）。mock 数据源没有持久化，传 null 即可 */
  meta: db.kv || null,
  cloud
})

export { COLLECTIONS, BILL_TYPES, CATEGORY_TYPES, NAME_MAX_LENGTH } from './contract.js'
export { NotImplementedError, RepositoryError, SCHEMA_VERSION } from './contract.js'
