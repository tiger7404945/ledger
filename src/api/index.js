/**
 * 数据层装配入口
 * ------------------------------------------------------------
 * 视图与 store 只依赖这里导出的 repository，不关心底层实现。
 * 第二阶段切换本地缓存 / 云端同步时，只需改动 DATA_SOURCE。
 */
import { createMockAdapter } from './adapters/mockAdapter.js'
import { createIdbAdapter } from './adapters/idbAdapter.js'
import { createLeanCloudAdapter } from './adapters/leancloudAdapter.js'

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
 * 也为后续云端增量同步留好了 outbox 队列。切回 mock 只需改这一行。
 */
export const DATA_SOURCE = 'idb'

export const db = ADAPTERS[DATA_SOURCE](ADAPTER_OPTIONS[DATA_SOURCE])

export const ledgerRepo = db.ledger
export const categoryRepo = db.category
export const billRepo = db.bill

/**
 * 云端同步引擎（第二阶段启用）
 *
 * 注意：LeanCloud 已停服（2026-01 冻结注册、2027-01 关闭服务），
 * 第二阶段改接 Supabase，本占位会在那时替换为 supabaseAdapter，
 * 详见 phase2-backend-plan.md。当前导出未接入任何运行时路径，
 * 仅作为「同步引擎入口」的位置标记。
 */
export const cloudSync = createLeanCloudAdapter({
  // 凭据由运行时配置注入（第二阶段改为 Supabase 的 url / anonKey）
})

export { COLLECTIONS, BILL_TYPES, CATEGORY_TYPES, NAME_MAX_LENGTH } from './contract.js'
export { NotImplementedError, RepositoryError, SCHEMA_VERSION } from './contract.js'
