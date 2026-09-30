/**
 * 远端增量合并规则
 * ------------------------------------------------------------
 * 与 core/query.js 同理：凡是「业务规则」就只写一份，供各适配器共用，
 * 从构造上杜绝「两处实现各写一套、慢慢漂开」。
 *
 * 这里只回答一个问题：**远端拉回来的这条文档，本地该不该采纳？**
 *
 * 策略是最简单的 LWW（last write wins）：`updatedAt` 大者胜。
 *
 * ⚠️ `updatedAt` 是**客户端时钟**打的，所以「新者胜」原本依赖设备时钟准不准。
 * S4-2 起由调用方传入 `clockOffset`（服务端时间 - 本地时间）把两边换算到
 * 服务端时间轴上再比 —— 数据不用改写，只在比较的那一刻校正。详见 shouldTakeRemote。
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
 *
 * ## 时钟校正（S4-2）
 *
 * `updatedAt` 是**各设备自己的客户端时钟**打的。慢的那台永远输 ——
 * 它写了一笔，本地时间却比云端已有的旧记录更早，于是新数据被判成旧的丢掉。
 *
 * `clockOffset` 用来修正这个偏差。它由引擎从**服务端时间**算出来：
 *
 *     clockOffset = 服务端时间 - 本地时间     （>0 表示本机时钟**慢**了）
 *
 * 比较时给**本地那份**加上偏移，把两边都换算到「服务端时间轴」上：
 *
 *     本地校正后 = localDoc.updatedAt + clockOffset
 *
 * **为什么不直接把偏移写进文档的 `updatedAt`**：那样要改写历史数据，
 * 而且偏移会随网络往返抖动变化，写进去就固化了错误。在**比较的那一刻**校正，
 * 数据保持原样，随时可以换一个更准的偏移。
 *
 * ⚠️ `clockOffset` 只在服务端时间**可信**时才该传（`source === 'cloud-function'`）。
 * 降级的「水位线下界」是下界不是当前时间，拿它算偏移会把本地时钟**推慢**，
 * 反而制造新的错判。传 `0` 即退回原来的行为。
 *
 * @param {object|null|undefined} localDoc  本地文档
 * @param {object} remoteDoc                远端文档
 * @param {number} [clockOffset=0]          本地时钟相对服务端的偏差（毫秒）
 */
export function shouldTakeRemote(localDoc, remoteDoc, clockOffset = 0) {
  if (!localDoc) return true
  const offset = Number.isFinite(clockOffset) ? clockOffset : 0
  const localTs = (localDoc.updatedAt || 0) + offset
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
 * @param {number} [clockOffset=0] 本地时钟偏差（见 shouldTakeRemote）
 * @returns {{ take: Array, keep: Array }}
 */
export function partitionRemote(localDocs, remoteDocs, clockOffset = 0) {
  const localById = new Map((localDocs || []).map((d) => [d.id, d]))
  const take = []
  const keep = []
  ;(remoteDocs || []).forEach((raw) => {
    const doc = fromRemote(raw)
    if (!doc) return
    if (shouldTakeRemote(localById.get(doc.id), doc, clockOffset)) take.push(doc)
    else keep.push(doc)
  })
  return { take, keep }
}
