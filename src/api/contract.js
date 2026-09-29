/**
 * ============================================================
 *  数据层契约（Repository Contract）
 * ============================================================
 *  第一阶段只实现 mockAdapter；后续接入本地离线缓存与云端同步时，
 *  只需新增实现同一套契约的 adapter，视图层与 store 层零改动。
 *
 *  分层：
 *    views / components
 *          ↓
 *      Pinia stores
 *          ↓
 *      repository（本文件定义的契约）
 *          ↓
 *   ┌──────────────┬──────────────┬─────────────────┐
 *   │ mockAdapter  │ idbAdapter   │ leancloudAdapter │
 *   │ （本期）      │ （离线缓存）  │ （联网增量同步）  │
 *   └──────────────┴──────────────┴─────────────────┘
 *
 *  所有方法均返回 Promise，且必须遵循「本地先行（local-first）」：
 *  写操作先落本地、再入 outbox 队列，由同步引擎异步推送。
 */

export const SCHEMA_VERSION = 1

export const COLLECTIONS = {
  LEDGER: 'ledger',
  CATEGORY: 'category',
  BILL: 'bill'
}

/** 账单类型 */
export const BILL_TYPES = {
  EXPENSE: 'expense',
  INCOME: 'income',
  TRANSFER: 'transfer',
  LENDING: 'lending'
}

/** 分类类型 */
export const CATEGORY_TYPES = {
  EXPENSE: 'expense',
  INCOME: 'income'
}

export const NAME_MAX_LENGTH = 8

/**
 * @typedef {Object} Ledger 账本
 * @property {string} id
 * @property {string} name
 * @property {string} ownerId
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} Category 分类（parentId === null 表示一级分类）
 * @property {string}  id
 * @property {string}  name
 * @property {string}  icon        图标 id，见 components/icons
 * @property {string?} parentId    null = 一级分类
 * @property {'expense'|'income'} type
 * @property {string}  ledgerId
 * @property {number}  order
 * @property {number}  createdAt
 * @property {number}  updatedAt
 * @property {0|1}     [deleted]   软删除标记，供增量同步
 */

/**
 * @typedef {Object} Bill 账单
 * @property {string}  id
 * @property {string}  ledgerId
 * @property {'expense'|'income'|'transfer'|'lending'} type
 * @property {number}  amount                正数，单位元
 * @property {string?} categoryId            二级分类 id（无二级时为一级分类 id）
 * @property {string?} primaryCategoryId     一级分类 id
 * @property {string}  remark
 * @property {string}  date                  YYYY-MM-DD
 * @property {boolean} noReimburse
 * @property {number}  createdAt
 * @property {number}  updatedAt
 * @property {0|1}     [deleted]
 * @property {number}  [version]             服务端同步版本号
 */

/**
 * @typedef {Object} OutboxEntry 增量同步队列条目
 * @property {string} id
 * @property {'category'|'bill'|'ledger'} collection
 * @property {'create'|'update'|'delete'} op
 * @property {string} docId
 * @property {Object} payload
 * @property {number} ts
 * @property {number} retry
 * @property {boolean} synced
 */

/**
 * 适配器必须实现的完整接口（供后续 idbAdapter / leancloudAdapter 对照实现）：
 *
 * ledger:   list() | get(id) | update(id, patch)
 * category: list({ ledgerId, type }) | get(id) | create(payload) | update(id, patch)
 *           | remove(id, { cascade }) | listChildren(parentId) | reorder(orderedIds)
 * bill:     list({ ledgerId, month, from, to, date, type, categoryId, keyword, order }) | get(id)
 *           | create(payload) | update(id, patch) | remove(id)
 *           | summary({ ledgerId, month, from, to })
 *           | listByMonthGroups({ ledgerId, month })
 *           | remarkHistory({ ledgerId, categoryId, limit })
 * sync:     pendingCount() | push() | pull(since) | subscribe(cb)
 *
 * 关于账单的区间条件：month（'YYYY-MM'）与 from / to（'YYYY-MM-DD'，含首尾）是两套等价写法，
 * 同时传入时按 AND 处理。账单页「按月 / 按年」筛选统一用 from / to 表达区间。
 */
export class NotImplementedError extends Error {
  constructor(what) {
    super(`[ledger] ${what} 尚未实现（第一阶段仅提供 mockAdapter）`)
    this.name = 'NotImplementedError'
  }
}

export class RepositoryError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RepositoryError'
    this.code = code
  }
}
