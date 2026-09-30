/**
 * 远端增量合并规则
 * ------------------------------------------------------------
 * 与 core/query.js 同理：凡是「业务规则」就只写一份，供各适配器共用，
 * 从构造上杜绝「两处实现各写一套、慢慢漂开」。
 *
 * 这里只回答一个问题：**远端拉回来的这条文档，本地该不该采纳？**
 *
 * 策略是最简单的 LWW（last write wins）：`updatedAt` 大者胜。
 * 它的代价写在 phase2-backend-plan.md 里 —— 依赖客户端时钟，
 * 时钟慢的设备永远输；真正的修法是 S4 用服务端时间裁决。
 *
 * 另一个容易踩的点：**云端 `_id` 不等于本地 id**（S4-7 方案 A 之后是别名）。
 * 凡是要「按 id 对应上」的地方，一律走 `fromRemote()` 取出的 `id`，
 * 不要直接读 `_id`。
 */

export const MERGE = {
  TAKE_REMOTE: 'remote',
  KEEP_LOCAL: 'local'
}

/**
 * 云端文档 → 本地文档形状。
 *
 * 带下划线的都是**服务端元数据**（`_openid` 归属字段、`_serverTs` 接收时间），
 * 一律不落本地库 —— 它们由服务端维护，本地留着既没用又会误导后续判断。
 *
 * **本地 id 怎么恢复**（S4-7 方案 A 之后）：
 * 云端 `_id` 已经**不等于**本地 id 了 —— 它是 `<账号前缀>_<本地 id>` 的别名，
 * 用来避开「`_id` 跨账号全局唯一」这个坑。本地 id 现在留在**业务字段 `id`** 里。
 * 所以这里优先取 `id`；只有拿不到时才退回 `_id`（兼容旧格式文档，
 * 以及 mock/fake 云端那种「`_id` 就等于本地 id」的实现）。
 *
 * ⚠️ 不要改成「从别名里解析出本地 id」—— 别名格式一改就会错，
 * 而且本地 id 自身可能含下划线。业务字段是权威来源。详见 `core/cloudId.js`。
 */
export function fromRemote(doc) {
  if (!doc) return null
  const { _id, _openid, _serverTs, ...rest } = doc
  void _openid
  void _serverTs
  const id = rest.id || _id
  return id ? { ...rest, id } : null
}

/**
 * 新者胜裁决：远端是否应该覆盖本地。
 * updatedAt 相等时以云端为准（同一毫秒内的并发写入，两边内容通常一致，取谁都不影响）。
 */
export function shouldTakeRemote(localDoc, remoteDoc) {
  if (!localDoc) return true
  const localTs = localDoc.updatedAt || 0
  const remoteTs = remoteDoc.updatedAt || 0
  return remoteTs >= localTs
}

/**
 * 把远端一批文档分成两堆：该采纳的、该保留本地的。
 * 保留本地的那部分**必须继续留在 outbox 里**等下一轮推送，
 * 否则本地这次改动就永远上不了云。
 *
 * @param {Array} localDocs 本地当前的全量文档（同集合）
 * @param {Array} remoteDocs 远端拉回的增量文档
 * @returns {{ take: Array, keep: Array }}
 */
export function partitionRemote(localDocs, remoteDocs) {
  const localById = new Map((localDocs || []).map((d) => [d.id, d]))
  const take = []
  const keep = []
  ;(remoteDocs || []).forEach((raw) => {
    const doc = fromRemote(raw)
    if (!doc) return
    if (shouldTakeRemote(localById.get(doc.id), doc)) take.push(doc)
    else keep.push(doc)
  })
  return { take, keep }
}
