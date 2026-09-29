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

/** 当前数据源：mock | idb */
export const DATA_SOURCE = 'mock'

export const db = ADAPTERS[DATA_SOURCE]({ namespace: 'ledger' })

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
