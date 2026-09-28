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

/** 云端同步引擎（第二阶段启用） */
export const cloudSync = createLeanCloudAdapter({
  // appId / appKey / serverURL 由运行时配置注入
})

export { COLLECTIONS, BILL_TYPES, CATEGORY_TYPES, NAME_MAX_LENGTH } from './contract.js'
export { NotImplementedError, RepositoryError, SCHEMA_VERSION } from './contract.js'
