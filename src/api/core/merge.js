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
 * 取一条文档的**有效服务端刻度**。没有（或已失效）则返回 0。
 *
 * `serverUpdatedAt` 由云函数在服务端**接收写入时**生成，随文档同步到各设备。
 * 两台设备拿到的是**同一个客观值**，不再依赖对方的本地时钟 —— 这是唯一能真正
 * 解决跨设备裁决的路子（详见 shouldTakeRemote）。
 *
 * ⚠️ **不要复用 `_serverTs`**：它承担「水位线」职责（服务端接收时间）。
 *   两者语义不同 —— 水位线回答「我拉到哪了」，裁决键回答「这份内容是哪一刻的」。
 *   而且 `_serverTs` 读回来是 Date 对象、还必须用 `_.gte(new Date(0))` 才能比，
 *   语义混用会让两件事都变得难以独立演进。
 *
 * ## 为什么刻度可能「失效」
 *
 * `serverUpdatedAt` 的语义是「**服务端接收到这份内容**的时刻」。本地文档一旦被
 * **再次修改**，那个刻度就不再代表当前内容了 —— 它标的是**上一版**的接收时刻：
 *
 *     ① 设备从云端拉到 v1，附带刻度 T1（内容 v1 在 T1 被服务端接收）
 *     ② 用户本地改成 v2（只更新了 `updatedAt`，刻度字段原样留着，还是 T1）
 *     ③ 同步：本地 v2(刻度 T1) vs 云端 v1(刻度 T1) → 刻度相等 → 判定「云端更新」
 *        ⇒ **本地刚改的 v2 被 v1 覆盖掉**，用户白改了
 *
 * 判据：**本地 `updatedAt` 晚于刻度** ⇒ 内容比刻度新 ⇒ 刻度已失效，不能拿它裁决。
 *
 * 这条判据在两种时钟下都成立：
 *   - 时钟准：改完 `updatedAt` 必然 > 上次接收时刻；
 *   - 时钟慢：`updatedAt` 可能仍小于刻度，此时刻度**不算失效**，退回客户端时间戳
 *     比较 + 单侧偏移校正（S4-2 行为）—— 慢时钟的识别交给 `clockOffset`。
 *
 * ⚠️ 不要「修改时顺手清掉本地刻度」。清掉看着更直观，但要做到得改**所有写路径**
 *    （适配器的 create / update / 批量导入 / 迁移……），漏掉一处就静默错判。
 *    把判断收在裁决这一处，改一个函数就够，且**不可能漏**。
 *
 * ⚠️ **两端都要做数**：只有 `updatedAt`（云端还没被云函数盖过刻度，比如首次推送）
 *    → 用客户端时钟，退回 S4-2 行为，**比完全没有强**；只有 `serverUpdatedAt`
 *    （理论上的畸形数据）→ 也认，别丢。
 */
function effectiveServerStamp(doc) {
  if (!doc) return 0
  const stamp = Number(doc.serverUpdatedAt)
  if (!Number.isFinite(stamp) || stamp <= 0) return 0
  // 内容比刻度还新 ⇒ 刻度标的是上一版，已失效
  const contentTs = Number(doc.updatedAt) || 0
  if (contentTs > stamp) return 0
  return stamp
}

/**
 * 新者胜裁决：远端是否应该覆盖本地。
 * 时间相等时以云端为准（同一毫秒内的并发写入，两边内容通常一致，取谁都不影响）。
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
 * ## 偏移只在「比客户端时间戳」时才加（S4-6 后）
 *
 * 有了服务端刻度以后，**刻度那一侧不需要也不应该加偏移** —— 它本来就在服务端
 * 时间轴上。给已经校正过的时间再加一次偏移，会把刚修好的分叉重新引入。
 * 所以：
 *
 *   - 用 `serverUpdatedAt` 比 → 两边都是服务端刻度，**不加偏移**；
 *   - 退回 `updatedAt` 比   → 只有本地那侧加偏移（S4-2 的老行为）。
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

  /**
   * 两边都有**有效**服务端刻度，且**刻度能分出高下** → 直接比刻度。
   *
   * ⚠️ 「有效」是必须的（见 effectiveServerStamp）：本地内容若已比自己的刻度更新，
   *    说明本地又被改过，那个刻度标的是上一版，不能拿来比。
   *    少了这一层判断，会出现「本地刚改完，同步时被云端旧内容覆盖回去」。
   *
   * ⚠️ **刻度相等时不能直接判「云端赢」**。相等的含义是「两份内容是在同一刻被
   *    服务端接收的」—— 那通常意味着它们**本来就是同一版**，取谁都行。
   *    但也可能不是：
   *
   *      B（慢时钟）拉到 v1（刻度 T1）→ 本地改成 v2 → 推送前先 pull
   *      本地 v2：updatedAt = 慢时钟值（比 T1 早），刻度字段仍是 T1
   *      云端 v1：updatedAt = T1 附近，刻度 = T1
   *      ⇒ 刻度相等。若直接判「云端赢」，**B 刚改的 v2 就被 v1 冲掉**。
   *
   *    所以刻度相等时落到下面的 `updatedAt` 比较：两边内容时间不同，说明是两版
   *    不同的内容，必须按 S4-2 的规则（`updatedAt` + 单侧偏移校正）分高下。
   *    「N 台设备在同一毫秒各写一版」那种真正的内容相异但刻度相同的情形，
   *    偏移校正后的 `updatedAt` 依然是当前能做到的最好判据。
   */
  const localServer = effectiveServerStamp(localDoc)
  const remoteServer = effectiveServerStamp(remoteDoc)
  if (localServer > 0 && remoteServer > 0 && localServer !== remoteServer) {
    return remoteServer > localServer
  }

  /**
   * 其余情况统一退回 S4-2 的老逻辑：
   *   - 有一侧没有有效刻度（本地刚改过 / 云端还没被云函数盖过）；
   *   - 或两侧刻度相同（无法据此分高下，见上）。
   * 双方都归到「客户端时间戳」这一比，只给本地那侧加偏移校正。
   *
   * ⚠️ 这里用 `updatedAt` 而不是「有效刻度优先」：既然刻度分不出高下，
   *    就该老老实实按内容时间比 —— 否则会变成「一侧用刻度、一侧用 updatedAt」，
   *    两个时间轴混比，结果没有意义。
   */
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
