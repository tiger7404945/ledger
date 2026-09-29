import { NotImplementedError } from '../contract.js'
import { outbox } from '../sync/outbox.js'

/**
 * LeanCloud 适配器（已废弃的选型，保留作参考）
 * ------------------------------------------------------------
 * ⚠️ 选型作废说明：LeanCloud 已发布停服公告 ——
 *     2026-01-12 起停止新用户注册、停止创建新应用；
 *     2027-01-12 正式关闭全部对外服务（应用访问 / 数据读写 / API / 控制台）。
 *   第一阶段预留本骨架时尚未停服，现已无法开通，**不要照此实现**。
 *
 *   第二阶段云端同步改用 Supabase，见 phase2-backend-plan.md。
 *   本文件保留的原因：其中的「本地为主、云端为副本、outbox 增量推送 +
 *   水位增量拉取 + updatedAt 新者胜」这套同步策略与厂商无关，
 *   supabaseAdapter 会沿用同一套思路，可作为设计参考。
 *
 * ------------------------------------------------------------
 * 目标：本地 IndexedDB 为主存储，云端作为副本，
 *      支持离线写入 → 联网后按 outbox 增量推送，以及按 updatedAt 增量拉取。
 *
 * 使用方式（第二阶段）：
 *   import AV from 'leancloud-storage'
 *   AV.init({ appId, appKey, serverURL })
 *
 * 云端 Class 设计：
 *   Ledger   : name, ownerId
 *   Category : localId(String), name, icon, parentLocalId, type, ledgerId, order, deleted
 *   Bill     : localId(String), ledgerId, type, amount, categoryLocalId,
 *              primaryCategoryLocalId, remark, date, noReimburse, deleted, version
 *
 * 同步策略：
 *   push  —— 取 outbox.pending()，按 op 调用 cloud.save/update/destroy；
 *            成功后 outbox.markSynced(ids)，失败 outbox.bumpRetry(id) 并指数退避。
 *            幂等键 = localId，服务端 upsert。
 *   pull  —— 以 meta.lastSyncAt 为水位，查询 updatedAt > lastSyncAt 的记录，
 *            与本地按 updatedAt 比较后「新者胜」写入 IndexedDB，并更新水位。
 *   冲突   —— 同一文档本地/云端都改过时，updatedAt 大者胜；相等时以云端为准。
 */

export function createLeanCloudAdapter(options = {}) {
  const {
    appId = '',
    appKey = '',
    serverURL = '',
    lastSyncKey = 'ledger.sync.lastSyncAt'
  } = options

  void appId
  void appKey
  void serverURL

  const meta = {
    get lastSyncAt() {
      const raw = localStorage.getItem(lastSyncKey)
      return raw ? Number(raw) : 0
    },
    set lastSyncAt(value) {
      localStorage.setItem(lastSyncKey, String(value))
    }
  }

  return {
    name: 'leancloud',
    /** @returns {Promise<boolean>} 是否初始化成功 */
    async initialize() {
      throw new NotImplementedError('leancloudAdapter.initialize')
    },
    /** 增量推送本地 outbox */
    async push() {
      const pending = outbox.pending()
      throw new NotImplementedError(`leancloudAdapter.push（当前待推送 ${pending.length} 条）`)
    },
    /** 增量拉取云端变更 */
    async pull() {
      throw new NotImplementedError('leancloudAdapter.pull')
    },
    /** 全量重建（首次绑定帐号时使用） */
    async syncAll() {
      throw new NotImplementedError('leancloudAdapter.syncAll')
    },
    meta
  }
}
