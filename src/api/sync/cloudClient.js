/**
 * 云端客户端契约（只有形状，没有实现）
 * ------------------------------------------------------------
 * 这个文件里一行逻辑都没有，它存在的唯一目的是把「同步引擎需要云端提供什么」
 * 固定下来。有了它：
 *
 *   - S2 的 fakeCloud 与 S3 的 cloudbaseAdapter 实现的是**同一套接口**，
 *     所以 S3 接真云端时，syncEngine 一行都不用改；
 *   - 调 bug 时可以先用假云端跑通调度逻辑，不用怀疑网络。
 *
 * 三个方法，语义如下：
 *
 *   pull(collection, { since, cursor, limit, ids })
 *     拉取增量。
 *     - since  —— 水位线：只要 updatedAt 严格大于它的文档（首次同步传 0）
 *     - cursor —— 游标：上一次返回的 cursor，为 null 表示从头开始
 *     - limit  —— 单页条数上限（云端有行数限制，必须分页）
 *     - ids    —— 精确拉取指定 id（用于「推送被拒后把云端版本拉回来」）
 *     返回 { docs, serverTime, hasMore, cursor }
 *     **docs 里必须带 updatedAt**，合并规则完全依赖它。
 *
 *   push(collection, docs)
 *     **条件 upsert**：只有当本地这份不旧于云端时才覆盖。
 *     幂等键是云端 `_id` = 本地 `id`，所以重复推送不会产生重复文档。
 *     返回 { upserted: string[], rejected: [{ id, cloudUpdatedAt }] }
 *
 *     ⚠️ rejected 这个字段是关键。如果云端因为「你这份更旧」而拒绝，
 *     却不把这件事告诉客户端，客户端会以为自己推成功了、云端还停在旧版本，
 *     两端就此分叉 —— 这个 bug 在单设备上测不出来，要等真的两台设备才暴露。
 *
 *   serverTime()
 *     服务端当前时间。用来做两件事：写水位线、以及在不信任客户端时钟时充当
 *     冲突裁决依据（S4-2）。
 *
 *     返回 `{ value: <毫秒时间戳>, source: <来源标记> }`，**不是裸数字**。
 *     `source` 让调用方能判断这个时间可不可信：
 *       - `'cloud-function'` —— 云函数返回的真服务端时钟，**可做裁决**；
 *       - `'watermark-lower-bound'` —— 降级取「能观察到的最新 `_serverTs`」，
 *         是**下界**：当水位线安全，**不能做裁决**。
 *
 *     为什么要区分：CloudBase Web SDK 没有「读服务端当前时间」的接口，
 *     真值必须来自云函数。云函数不可用时不能让同步整个失败，所以降级 ——
 *     但降级后的值不足以支撑「谁更新」的判断，必须让调用方知道。
 *
 *     ⚠️ 注意与 `pull()` 返回值里的 `serverTime` **不是一回事**：
 *     那个是「本页拉到的最大 `_serverTs`」，用于推进水位线，始终是数字。
 *     两者同名纯属历史巧合，改动时别搞混。
 *
 * 归属与权限：
 *   云开发会自动给带登录态的写入注入 `_openid`，读取时也由**安全规则**
 *   在服务端过滤。客户端不要自己维护这个字段，更不要试图用前端代码
 *   「过滤掉别人的数据」—— 客户端代码谁都能改。
 */

/** 单页默认条数（云端单次查询有行数上限，别一次要太多） */
export const CLOUD_PAGE_LIMIT = 100

export const CLOUD_METHODS = ['pull', 'push', 'serverTime']

/**
 * 检查一个对象是否长得像云端客户端。
 * 在装配处调用，能把「接口没对齐」这类错误在启动时就暴露出来，
 * 而不是等到第一次同步才炸。
 */
export function assertCloudClient(client) {
  if (!client) return false
  const missing = CLOUD_METHODS.filter((m) => typeof client[m] !== 'function')
  if (missing.length) {
    throw new Error(`[ledger] 云端客户端缺少方法：${missing.join(', ')}（见 sync/cloudClient.js）`)
  }
  return true
}
