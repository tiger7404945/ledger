/**
 * 云函数：ledger-sync-stamp —— 给一批文档盖上「服务端裁决刻度」（S4-6）
 * ------------------------------------------------------------
 * 解决的问题
 *   本地「新者胜」（LWW）原本比的是 `updatedAt`，而那是**各设备自己的客户端时钟**
 *   打的。S4-2 引入了 `clockOffset`（服务端时间 - 本地时间）来做校正，但它有个
 *   无法自我救赎的边界：
 *
 *       `clockOffset` 是**每台设备各自算的**，而合并时只给「本地那份」加偏移。
 *
 *   这等于假设「远端那份的时间戳已经在正确的时间轴上」—— 可远端也是某台客户端
 *   写的，它同样可能带偏移，而我们**不知道它偏多少**。于是：
 *
 *       A 时钟准  （offset   0）：A 的 10（…001000）+ 0    = …001000
 *       B 时钟慢 5s（offset +5000）：B 的 99（…999000）+ 5000 = …0004000
 *       A 比 → 自己的 …001000 更大 → 保留 10
 *       B 比 → 自己的 …0004000 更大 → 保留 99
 *       ⇒ 两端各自坚持自己那版，**反复同步也不收敛**（云端只有一条，两端内容不同）
 *
 *   这是 `scripts/conflict-test.mjs` 第 3 组 3g 刻意钉住的**真实缺陷**，
 *   不是理论风险。
 *
 * 这个函数干什么
 *   服务端在**接收写入的那一刻**自己算一个时间戳，写进**业务字段** `serverUpdatedAt`。
 *   各设备拉回来时拿到的是同一个**客观刻度**，不再依赖对方的本地时钟。
 *
 *   为什么用「业务字段」而不是复用它旁边的 `_serverTs`：
 *     - `_serverTs` 已经承担「同步水位线」职责 —— 它是**服务端接收时间**，
 *       水位线「宁可重复不能漏」的语义靠它；而且它在 CloudBase 里是特殊处理的
 *       服务端时间类型，读回来是 Date 对象。
 *     - `serverUpdatedAt` 承担「**内容版本时间**」职责 —— 回答的是「这份内容
 *       是哪一刻产生的」，用来比谁更新。
 *   两者语义不同，混用会让其中一个将来没法独立演进。**不要合并。**
 *
 *   也不用 `db.serverDate()`：那个只能写不能读，客户端拿不到值就没法比较。
 *   这里返回的是**明文毫秒数**，就是为了让客户端能读能比。
 *
 * 入参：**三种形态都认**（这是实测踩出来的，见下）
 *   HTTP 网关转发到 Event 型函数时，请求体的落点**不在 `event` 顶层**。
 *   官方文档说会包成 `{ path, httpMethod, headers, queryStringParameters, body,
 *   isBase64Encoded, requestContext }`，但实际形态随网关配置变化。
 *   与其猜，不如**三种都试**，谁在就用谁：
 *     ① `event.updates`              —— SDK 直调（invokeFunction）时的形态
 *     ② `event.body`（JSON 字符串）  —— HTTP 网关包装后的形态
 *     ③ `event.queryStringParameters.updates`（JSON 字符串）—— 兜底
 *   ⚠️ 猜错形态的后果是**静默的**：函数收不到 updates，照样返回
 *   `{ ok: true, stamps: {}, skipped: [] }`，看起来像「没有要盖的」，
 *   客户端会以为盖成功了。所以这里的容错是**必须的**，不是过度设计。
 *
 * 返回（客户端约定，不要改字段名）
 *   {
 *     ok: boolean,
 *     serverTime: number,                  // 函数执行时刻（毫秒），供客户端算偏移
 *     stamps: { [collection]: { [id]: number } },   // 真正写下去的值，逐条回报
 *     skipped: [ { collection, id, reason } ]       // 没写成的（不存在等）
 *   }
 *
 * ⚠️ 为什么返回 `stamps` 明细而不是只回一个 `ok`
 *   调用方要用它去**决定 outbox 条目作废还是保留**（S4-6 的 push 流程）。
 *   含糊的布尔返回值会让「没盖成功」的条目被误认为已同步 —— 那就是静默分叉。
 *
 * 凭据与身份
 *   函数只做「读一批别名 → 写时间戳」，**不涉及权限校验**：
 *   它操作的文档由调用方在客户端侧按 PRIVATE 权限读写，服务端这里只补一个刻度。
 *   ⚠️ 这说明它**可以被任意客户端调用** —— 所以它**不能**接受客户端传来的时间。
 *   刻度**一律由函数自己 `Date.now()` 生成**，客户端无从伪造，这是整个方案成立的前提。
 *
 *   鉴权（谁能调用它）这一层在部署侧控制，见 `src/config/cloud.js` 的说明：
 *   本项目用 HTTP 网关路由（`auth=false`），与 `ledger-server-time` 同一套。
 *   函数本身不返回任何他人数据，最坏情况只是被白刷调用次数。
 *
 * 命名
 *   本地目录名**必须与函数名完全一致**（`cloudfunctions/ledger-sync-stamp/`）——
 *   MCP 的 createFunction 用 `functionRootPath + '/' + 函数名` 拼本地路径。
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

/** 本地集合名 → 云端集合名。必须与 cloudbaseAdapter.js 的 CLOUD_COLLECTIONS 一致 */
const CLOUD_COLLECTIONS = {
  ledger: 'ledger_ledgers',
  category: 'ledger_categories',
  bill: 'ledger_bills'
}

/** 单次调用最多处理多少条 —— 防止一次塞进几千条把函数拖超时 */
const MAX_UPDATES = 200

/** 尽力把各种形态的入参解析成数组。解析不出来就返回空数组（调用方按「无事可做」处理） */
function parseUpdates(event) {
  const asArray = (v) => {
    if (Array.isArray(v)) return v
    if (typeof v === 'string' && v.trim()) {
      try {
        const parsed = JSON.parse(v)
        return Array.isArray(parsed) ? parsed : []
      } catch (e) {
        return []
      }
    }
    return []
  }

  // ① SDK 直调：参数就在顶层
  if (Array.isArray(event && event.updates)) return event.updates

  // ② HTTP 网关：body 是字符串，里面是完整的 { updates: [...] }
  const body = event && event.body
  if (typeof body === 'string' && body.trim()) {
    try {
      const parsed = JSON.parse(body)
      if (Array.isArray(parsed)) return parsed
      if (parsed && Array.isArray(parsed.updates)) return parsed.updates
    } catch (e) {
      /* 落到下面继续试 */
    }
  }
  // body 已经是对象（某些网关会预解析）
  if (body && typeof body === 'object' && Array.isArray(body.updates)) return body.updates

  // ③ query string 兜底：?updates=<URL 编码的 JSON>
  const q = (event && event.queryStringParameters) || {}
  if (q.updates) return asArray(q.updates)

  return []
}

/**
 * @param {object} event
 * @param {object} context
 * @returns {Promise<{ok: boolean, serverTime: number, stamps: object, skipped: Array, diag?: object}>}
 */
exports.main = async (event, context) => {
  const db = cloud.database()
  const cmd = db.command
  const serverTime = Date.now()

  const updates = parseUpdates(event)

  // 诊断开关：`?diag=1` 时把 event 形状原样回显，方便定位网关的入参落点。
  // 保留它是有价值的 —— 换网关配置 / 换云端时，「参数收不到」永远是第一个要排查的事。
  const q = (event && event.queryStringParameters) || {}
  if (q.diag === '1') {
    return {
      ok: true,
      serverTime,
      parsed: updates.length,
      eventKeys: Object.keys(event || {}),
      eventShape: JSON.stringify(event).slice(0, 1200),
      stamps: {},
      skipped: []
    }
  }

  const stamps = {}
  const skipped = []

  // 按集合归拢：一次调用里可能同时盖三个集合的文档
  const byCollection = new Map()
  for (const item of updates.slice(0, MAX_UPDATES)) {
    const local = item && item.collection
    const id = item && item.id
    const remote = CLOUD_COLLECTIONS[local]
    if (!remote || !id) {
      skipped.push({ collection: local || null, id: id || null, reason: 'unknown-collection-or-id' })
      continue
    }
    if (!byCollection.has(remote)) byCollection.set(remote, { local, ids: [] })
    byCollection.get(remote).ids.push(String(id))
  }

  for (const [remoteName, { local, ids }] of byCollection) {
    const col = db.collection(remoteName)

    /**
     * ⚠️ **先查存在性再写**，不能盲写。
     * 盲写有两个后果，且都是静默的：
     *   ① 这条 `_id` 根本不存在（客户端本地有、云端没推成功）→ 会**凭空造出一条
     *      只有 `serverUpdatedAt` 的空文档**，之后它被拉回本地会污染本地库；
     *   ② `_id` 存在但**属主是别人**（换过匿名身份）→ 写入抛 `E11000`，
     *      整批调用失败，把能写的那些也带崩。
     * 所以只对「确实存在、且服务端认为我能读到」的文档盖刻度。
     * PRIVATE 权限下读不到别人那份，于是这里天然只会盖到自己的。
     *
     * 分块查询：`_.in()` 的数组太长会让查询变慢甚至失败，按 100 一批。
     */
    const existing = new Set()
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100)
      const res = await col.where({ _id: cmd.in(chunk) }).field({ _id: true }).get()
      for (const doc of res.data || []) existing.add(doc._id)
    }

    stamps[local] = {}
    for (const id of ids) {
      if (!existing.has(id)) {
        skipped.push({ collection: local, id, reason: 'not-found' })
        continue
      }
      /**
       * 只改这两个字段，**不整份覆盖**。
       *
       * 为什么不能用 `.set(payload)`（整份覆盖）：本函数只负责盖刻度，
       * 但它拿不到那条文档的完整内容（客户端只传了 id）。整份覆盖会把业务字段
       * 全清成空 —— 那是比原缺陷严重得多的数据丢失。
       *
       * 为什么连 `_serverTs` 也在这里写：
       *   `_serverTs` 是**水位线**的依据，它和 `serverUpdatedAt` 都是「服务端
       *   接收这一刻」的产物。两处分别写（客户端 `db.serverDate()` 写水位线 +
       *   云函数写刻度）会得到**两个不同的时刻**，虽然相差毫秒级，但语义上
       *   没有理由让它们不一致。一次调用写一对，语义干净、也少一次往返。
       *
       *   ⚠️ 但这条路径只在**推送时**走。首次推送走的是 `.set()`（文档还不存在），
       *   那时 `_serverTs` 仍由客户端用 `db.serverDate()` 写 —— 两者不冲突，
       *   因为水位线只要求「单调不减」，不要求「同一个来源」。
       */
      const res = await col.doc(id).update({
        data: { serverUpdatedAt: serverTime, _serverTs: new Date(serverTime) }
      })
      /**
       * ⚠️ **别看 `res.updated`**：wx-server-sdk 的 `doc(id).update()` 返回结构
       * 与 Web SDK 不同（实测这里是 `{ stats: { updated: n } }` 形状，`res.updated`
       * 恒为 undefined）。用 `res.updated >= 1` 判断会把**每一条都误判成没写成**，
       * 于是 stamps 永远是空的 —— 客户端看到空的 stamps 会以为盖失败、把条目留在
       * 队列里反复重推。这个错误是静默的（不抛错），只能靠真机探针发现。
       *
       * 稳妥判断：`update()` 不抛错就认为写成功（文档已存在性是上一个查询保证的）。
       */
      const updatedCount =
        res?.updated ??
        res?.stats?.updated ??
        res?.stats?.created ?? // 有的实现把 upsert 也记在 created
        null
      const wrote = updatedCount === null ? true : Number(updatedCount) >= 1
      if (wrote) {
        stamps[local][id] = serverTime
      } else {
        // 明确回报「查到了但一条没改动」：多半是并发删掉了
        skipped.push({ collection: local, id, reason: 'not-updated' })
      }
    }
  }

  /**
   * 返回值要能同时满足两种消费方式：
   *   - 走 HTTP 网关（浏览器）→ 会被序列化成 JSON 响应体
   *   - SDK 直调 → 直接拿到对象
   * 两者形态一致，所以不用分支。
   */
  return { ok: true, serverTime, stamps, skipped }
}
