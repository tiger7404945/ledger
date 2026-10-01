/**
 * 云端文档 id 映射（S4-7 方案 A）
 * ------------------------------------------------------------
 * 一句话：**本地 id 不变，云端 `_id` 换成「带账号维度的别名」。**
 *
 * ## 为什么需要这一层
 *
 * CloudBase 的 `_id` 在**整个集合内全局唯一**（跨账号），而 `PRIVATE` 权限
 * 按 `_openid` **隔离读**。两者层级错位，撞出一个真实缺陷：
 *
 *   1. 新身份读不到旧身份写的文档（读被隔离）；
 *   2. 但那个 `_id` 已经被旧身份占着（写不隔离）。
 *
 * 于是「清 localStorage / 换设备 / 换浏览器 → 新身份」时：
 * 客户端**看不见** `ledger_default` 已被占用，只管写，服务端直接抛
 * `E11000 duplicate key`（500 / `DATABASE_REQUEST_FAILED`）。
 * 首次绑定因此**永久失败**，outbox 永远排不空。
 * 种子账本的 id 是常量 `ledger_default`、账单 id 也来自固定种子，
 * 所以这不只是理论风险 —— 真实场景必现。
 *
 * ## 修法：把 `_id` 的唯一性范围收进账号内
 *
 * 别名的形状：
 *
 *     <账号前缀>_<本地 id>
 *
 * - **账号前缀**：登录 uid 去掉不适合出现在 id 里的字符，取前 8 位。
 *   32 位 uid 只取 8 位会碰撞（生日界 ~2^16 个账号），但**碰撞后果是
 *   回到今天这个 bug**（两个账号抢同一个别名空间），不是数据泄露
 *   —— 而且 `_openid` 的读取隔离始终有效，最坏情况也只是「我推不上去」。
 * - **本地 id**：原样保留在别名尾部，**同时在业务字段 `id` 里也留一份**。
 *   这是这一层的核心技巧 —— 见下面「为什么把本地 id 也写进业务字段」。
 *
 * ## 为什么把本地 id 也写进业务字段
 *
 * 因为**本地库要能被完整还原**。`core/merge.js` 的 `fromRemote()` 剥掉
 * `_id` 之后必须能拿到原本的本地 id，否则云端拉回来的文档在本地就成了
 * 另一个主键，同一笔账会变成两条。
 *
 * 如果从别名里「反向解析」出本地 id 也能做，但那是脆的：别名格式一改、
 * 或者本地 id 本身带下划线，解析就会错。**把本地 id 显式写进业务字段，
 * 让恢复不依赖别名格式**，改格式时只要改这一处。
 *
 * （顺带：业务字段 `id` 本来就在推送 payload 里 —— `cloudbaseAdapter`
 * 一直写着 `payload.id = id`，所以这不是新增负担。）
 *
 * ## 为什么采用这一层，而不是让本地 id 自己带账号
 *
 * 若直接改 `uid()` 让本地 id 带上账号，那么**同一个人换设备后会拿到新 id**，
 * 旧文档在云端和本地都成了孤本，跨设备「同一笔账」的语义彻底断掉。
 * 把它做成**云端边界的一层映射**，好处是：
 *   - 本地 id 保持设备无关 → 跨设备合并、种子数据、导出都照旧；
 *   - 视图层 / store / 适配器契约**零改动**（别名只在云适配器内部出现）；
 *   - 账号前缀可以随时**重写**（S7 之前是「匿名转正」，现在是「换个账号登录」），
 *     本地 id 一根汗毛都不用动。
 *
 * ## 边界
 *
 * 这一层**只服务云适配器**。mock / idb 适配器不 import 它 ——
 * 本地库里的 `_id` 概念根本不存在（本地用的是 `id`）。
 */

/** 账号前缀取多长。8 位是「碰撞概率可接受」与「id 别太长」之间的折中 */
export const CLOUD_ID_PREFIX_LENGTH = 8

/**
 * **未登录**时的账号前缀（S7-2）。
 *
 * 以前叫 `'anon'`（匿名账号），S7 去掉匿名身份后改叫 `'guest'`：它现在表示的
 * 是「这台设备上还没登录」，不是「某个匿名账号」。库名与云端别名都跟着变
 * —— `ledger_guest`。旧分区 `ledger_anon` / `ledger_<匿名uid>` 不再被读取。
 */
export const GUEST_ACCOUNT_PREFIX = 'guest'

/** 别名前缀与本地 id 之间的分隔符。用下划线，与本地 id 的 `_` 不冲突（靠位置切分，不靠 split） */
export const CLOUD_ID_SEPARATOR = '_'

/**
 * 登录 uid → 可安全放进 `_id` 的账号前缀。
 *
 * CloudBase 的 uid 形如 `kqjV1DcPvon2m-UE0E0XMQ`，含 `-` 和大小写字母。
 * `_id` 允许这些字符，但为了别名可读、可 grep，这里统一：
 *   去掉非字母数字 → 截断到 8 位 → 小写。
 *
 * @param {string|null|undefined} uid 登录 uid
 * @returns {string} 账号前缀；取不到 uid 时返回 {@link GUEST_ACCOUNT_PREFIX}
 *   （调用方本就不该在未登录时调 —— S7 之后云端读写会直接抛 `NOT_SIGNED_IN`）
 */
export function accountPrefixOf(uid) {
  const cleaned = String(uid || '')
    .replace(/[^0-9a-zA-Z]/g, '')
    .toLowerCase()
  if (!cleaned) return GUEST_ACCOUNT_PREFIX
  return cleaned.slice(0, CLOUD_ID_PREFIX_LENGTH)
}

/**
 * 本地 id + 账号 → 云端别名。
 *
 * @param {string} localId 本地 id（文档的业务主键）
 * @param {string} prefix  `accountPrefixOf(uid)` 的结果
 * @returns {string} 云端 `_id`
 */
export function toCloudId(localId, prefix) {
  return `${prefix}${CLOUD_ID_SEPARATOR}${localId}`
}

/**
 * 从云端文档取回本地 id。
 *
 * 优先用业务字段 `id`（新格式）；取不到再退回 `_id`（旧格式的历史文档，
 * 或者 mock/fake 云端那种「`_id` 就等于本地 id」的实现）。
 *
 * ⚠️ **刻意不做别名反解析**：别名格式改了、或者本地 id 里带下划线，
 * 反解析都会出错。业务字段才是权威来源，这就是它存在的意义。
 *
 * @param {object} doc 云端文档
 * @returns {string|null}
 */
export function toLocalId(doc) {
  if (!doc) return null
  if (doc.id) return doc.id
  return doc._id || null
}
