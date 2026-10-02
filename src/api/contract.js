/**
 * ============================================================
 *  数据层契约（Repository Contract）
 * ============================================================
 *  视图与 store 只认这份契约，换存储实现时两边零改动。
 *
 *  分层：
 *    views / components
 *          ↓
 *      Pinia stores
 *          ↓
 *      repository（本文件定义的契约）
 *          ↓
 *   ┌──────────────┬─────────────────────────────────┐
 *   │ mockAdapter  │ idbAdapter                      │
 *   │ 内存/测试基座 │ 本地权威存储（IndexedDB，离线）  │
 *   └──────────────┴─────────────────────────────────┘
 *                        ↓ 变更走 outbox
 *              syncEngine + cloudbaseAdapter（云端副本）
 *
 *  ⚠️ 云端**不是**一个 repository 实现：同步是「跨集合、跨存储」的行为，
 *     由 `sync/syncEngine.js` 调度，适配器只提供读写口（见文件末说明）。
 *     LeanCloud 适配器骨架已随选型作废删除（2026-10-02，见 phase2-backend-plan.md）。
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

/**
 * 账单类型。
 *
 * ⚠️ 记账页只产出 `expense` / `income`（第二阶段的决定：「转账」「借贷」
 *    在 UI 上已下线）。枚举仍保留全部取值，是为了让**历史文档**（早期构建
 *    或直接调 API 写入的）照常通过同步进出，不至于因为读到未知取值就把
 *    文档判成脏数据丢掉。
 */
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
 * @property {number} createdAt
 * @property {number} updatedAt
 *
 * ⚠️ 曾经有个 `ownerId`（值恒为 `'user_local'`）。它是第一阶段「还没有账号体系」
 *    时的占位，**云端真正的归属靠 `_openid`**，本地则靠库分区隔离 ——
 *    这个字段从写入到读取都没有任何消费者，已于 S8-5 删除。
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
 * @property {'expense'|'income'|'transfer'|'lending'} type  实际只会写入 expense / income（见 BILL_TYPES）
 * @property {number}  amount                正数，单位元
 * @property {string?} categoryId            二级分类 id（无二级时为一级分类 id）
 * @property {string?} primaryCategoryId     一级分类 id
 * @property {string}  remark
 * @property {string}  date                  YYYY-MM-DD
 * @property {number}  createdAt
 * @property {number}  updatedAt
 * @property {0|1}     [deleted]
 *
 * ⚠️ S8-5 删掉了两个从不参与逻辑的字段，别再「顺手加回来」：
 *   - `noReimburse` —— 「不报销」开关在 S7-10 已从记账页下线，写入恒为 false；
 *   - `version`     —— 早期设想的「服务端同步版本号」，实际从未被读取。
 *     跨设备裁决用的是 `updatedAt` 与云端 `serverUpdatedAt`（见 core/merge.js）。
 *   两者的历史值已随 S8-5 的字段清理迁移一并从本地与云端移除。
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
 * 适配器必须实现的完整接口（mockAdapter / idbAdapter 对照实现，见 contract-test）：
 *
 * ledger:   list() | get(id) | update(id, patch)
 * category: list({ ledgerId, type }) | get(id) | create(payload) | update(id, patch)
 *           | remove(id, { cascade }) | listChildren(parentId) | reorder(orderedIds)
 * bill:     list({ ledgerId, month, from, to, date, type, categoryId, keyword, order }) | get(id)
 *           | create(payload) | update(id, patch) | remove(id)
 *           | summary({ ledgerId, month, from, to })
 *           | listByMonthGroups({ ledgerId, month })
 *           | remarkHistory({ ledgerId, categoryId, limit })
 * sync:     pendingCount()
 *
 * 关于同步：真正的推送 / 拉取**不在适配器上**，而在 `sync/syncEngine.js`。
 * 同步是「跨集合、跨存储」的行为，不属于某个适配器 —— 把它塞进适配器，
 * 每接一个新的云端就要把重试、水位、防抖重写一遍。适配器的职责只有两件事：
 *   1) 写操作时把改动 enqueue 进 outbox（**先落数据、再入队**）；
 *   2) 提供一个本地读写口 `syncStore`（get / applyRemote）给引擎用。
 * 云端需要提供什么，见 `sync/cloudClient.js`（S2 用 fakeCloud，S3 换成 CloudBase）。
 *
 * 关于账单的区间条件：month（'YYYY-MM'）与 from / to（'YYYY-MM-DD'，含首尾）是两套等价写法，
 * 同时传入时按 AND 处理。账单页「按月 / 按年」筛选统一用 from / to 表达区间。
 */
export class NotImplementedError extends Error {
  constructor(what) {
    super(`[ledger] ${what} 尚未实现`)
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
