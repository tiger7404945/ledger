/**
 * 腾讯云开发（CloudBase）云端客户端
 * ------------------------------------------------------------
 * 它实现的是 `sync/cloudClient.js` 定义的那三个方法（pull / push / serverTime），
 * 所以 **S2 的 syncEngine 一行都没改** —— 这就是当初把云端接口单独抽出来的回报。
 * 换真云端只需要动 `src/api/index.js` 里 `cloud` 那一行。
 *
 * ⚠️ 为什么不是 `@tencent-ai/workbuddy-cloud-sdk`
 *    本项目实测过三个 SDK（经过与结论见 .workbuddy/memory/2026-09-29.md）：
 *    - `@cloudbase/js-sdk` 走「自有 envId」入口，是浏览器业务数据的正解；
 *    - `@tencent-ai/workbuddy-cloud-sdk` 是 **WorkBuddy 托管应用**的入口：要求
 *      应用跑在自己的域名上（登录只在已注册的 HTTPS 发布域名可用，localhost 不行），
 *      而且刻意不提供匿名登录 —— 对一个 local-first 的个人记账 App 不合适。
 *    判断依据不是「哪个 SDK 更好」，而是**数据住在哪个环境**。
 *
 * 环境事实（全部实测，不是文档推断）：
 *   环境     my-cloudbase-********（体验版，ap-shanghai）
 *   后端     纯 NoSQL（`RuntimeBackends.postgresql === false`）→ 用 app.database() 集合
 *   权限     三个集合都是 PRIVATE（仅创建者可读写），**服务端**按 `_openid` 过滤
 *
 * 数据约定（与 sync/cloudClient.js 的契约对齐）：
 *   - **幂等键**：云端 `_id` 是「带账号维度的别名」= `<账号前缀>_<本地 id>`
 *     （见 `core/cloudId.js`），写入用 `doc(别名).set(...)`，它天然是 upsert，
 *     所以重复推送不会产生重复文档。
 *     ⚠️ 别名**不是**本地 id —— 本地 id 同时写在业务字段 `id` 里，
 *     拉回来时由 `fromRemote()` 从那个字段恢复。**别直接拿 `_id` 当本地 id。**
 *     为什么不直接用本地 id 当 `_id`：CloudBase 的 `_id` 在**集合内全局唯一、
 *     跨账号**，而 PRIVATE 权限按 `_openid` **隔离读**；两者错位会让换了身份的
 *     客户端「看不见却撞得上」，抛 `E11000`（S4-7 的真实缺陷）。
 *   - `_openid` 由 SDK **自动注入**，本地绝不能自己写（手写会直接报错）；
 *     拉回来时由 `core/merge.js` 的 `fromRemote()` 剥掉，不落本地库。
 *   - `_serverTs` 用 `db.serverDate()` 写入 = **服务端接收时间**，水位线只认它。
 *     不认客户端 `updatedAt` —— S2 跑测试时踩过：设备 B 的改动本地时间戳早、
 *     推上云晚，按 `updatedAt` 过滤会让设备 A 永久漏掉那条。
 *
 * ⚠️ 匿名账号 = 设备身份。登录态存在 localStorage，一旦被清掉就再也找不回
 *    那个账号和它的云端数据。S5 的「匿名转正」不是体验优化，是数据安全。
 *
 * 账号能力（S5-1，见文件末尾「账号体系」一节）：
 *   sendSmsCode / signInWithSms / signOut / getIdentity。
 *   除转正两步（uid 不变）外，其余会改 uid 的操作都要求调用方
 *   跟着重建本地数据层（库分区 S5-5），否则新账号会读到上一个账号的库。
 */

import { COLLECTIONS } from '../contract.js'
import { CLOUD_PAGE_LIMIT } from '../sync/cloudClient.js'
import { shouldTakeRemote } from '../core/merge.js'
import { accountPrefixOf, toCloudId, toLocalId } from '../core/cloudId.js'
import { CLOUD_FUNCTIONS, CLOUD_HTTP_PATHS } from '../../config/cloud.js'
import { cloudApiBase, isCloudApiConfigured } from '../../config/env.js'

/**
 * 云端集合名前缀。
 * 这个环境**可能被其它项目复用**（用户明确要求），所以每个集合都带项目前缀；
 * 再加 PRIVATE 权限按 `_openid` 隔离，两层互不干扰。
 */
export const CLOUD_COLLECTION_PREFIX = 'ledger_'

/** 本地集合名 → 云端集合名（显式映射，别用字符串拼，免得有人改名后静默错位） */
export const CLOUD_COLLECTIONS = {
  [COLLECTIONS.LEDGER]: 'ledger_ledgers',
  [COLLECTIONS.CATEGORY]: 'ledger_categories',
  [COLLECTIONS.BILL]: 'ledger_bills'
}

/** 带下划线的都是服务端元数据，推送前一律剥掉（`_openid` 手写会报错） */
function stripServerMeta(doc) {
  const out = {}
  for (const key of Object.keys(doc)) {
    if (!key.startsWith('_')) out[key] = doc[key]
  }
  return out
}

/** Date / ISO 串 / 数字 → 毫秒数。取不到就返 0（当作「比任何时间都早」） */
function toMillis(value) {
  if (value == null) return 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const ms = Number(new Date(value))
  return Number.isFinite(ms) ? ms : 0
}

export function createCloudBaseAdapter({
  env,
  pageLimit = CLOUD_PAGE_LIMIT,
  /**
   * 登录态持久化方式。`'local'` = 存 localStorage，刷新/重启浏览器仍在。
   * 匿名身份**必须**持久化，否则每次打开都是一个新账号、看不到自己上次的数据。
   */
  persistence = 'local',
  /** SDK 加载器。默认动态 import（拆成独立 chunk，不让首屏白白多背 700KB）；测试可注入替身 */
  loadSdk = () => import('@cloudbase/js-sdk')
} = {}) {
  if (!env) throw new Error('[ledger] CloudBase 适配器缺少 env（环境 ID），见 .env.local')

  let sdkPromise = null
  let appPromise = null
  let dbPromise = null
  let authPromise = null
  let signInPromise = null
  let currentUid = null
  /**
   * 当前账号的云端 id 前缀（S4-7 方案 A）。
   * 别名 = `<前缀>_<本地 id>`，用来把 `_id` 的唯一性范围收进账号内。
   * 每次拿到 uid 时同步刷新，见 `setUid()`。
   */
  let currentPrefix = null
  let lastError = null
  const authListeners = new Set()

  /** 唯一设置 uid 的入口 —— 保证 `currentPrefix` 永远跟 uid 同步，不会各更各的 */
  function setUid(uid) {
    currentUid = uid || null
    currentPrefix = uid ? accountPrefixOf(uid) : null
    return currentUid
  }

  const emitAuth = () => {
    const payload = { uid: currentUid, env, error: lastError }
    authListeners.forEach((cb) => {
      try {
        cb(payload)
      } catch (e) {
        /* 订阅者的异常不该影响同步本身 */
      }
    })
  }

  async function getSdk() {
    if (!sdkPromise) {
      sdkPromise = Promise.resolve(loadSdk()).then((m) => m.default || m)
    }
    return sdkPromise
  }

  async function getApp() {
    if (!appPromise) {
      appPromise = getSdk().then((cloudbase) => cloudbase.init({ env }))
    }
    return appPromise
  }

  async function getDb() {
    if (!dbPromise) {
      dbPromise = getApp().then((app) => app.database())
    }
    return dbPromise
  }

  /**
   * 拿到 SDK 的 auth 实例 —— **必须缓存**。
   *
   * ⚠️ 不能每次 `app.auth()` 现取一个新对象：SDK 里 auth 实例自己持有
   *    会话/内存态（`currentUser`、刷新定时器、事件订阅）。现取多份会出现
   *    「A 实例登录了，B 实例的 `currentUser` 还是 null」——`getIdentity()`
   *    与 `ensureSignedIn()` 用不同实例时就是这个症状。
   *    `ensureSignedIn` 原先也是每次现取，一并收敛到这里。
   */
  async function getAuth() {
    if (!authPromise) {
      authPromise = getApp().then((app) => app.auth({ persistence }))
    }
    return authPromise
  }

  /** 依次尝试几个可能的取用户接口 —— SDK 版本间命名有差异，别把鸡蛋放一个篮子 */
  async function resumeUser(auth) {
    try {
      if (typeof auth.getLoginState === 'function') {
        const st = await auth.getLoginState()
        const u = st?.user || st
        if (u?.uid) return u
      }
    } catch (e) {
      /* 没有可复用的登录态是正常情况，继续往下走 */
    }
    try {
      if (auth.currentUser?.uid) return auth.currentUser
    } catch (e) {
      /* 同上 */
    }
    try {
      if (typeof auth.hasLoginState === 'function') {
        const st = await auth.hasLoginState()
        const u = st?.user || st
        if (u?.uid) return u
      }
    } catch (e) {
      /* 同上 */
    }
    return null
  }

  /**
   * 取「可用的正式身份」，**匿名登录态一律视为没有身份**（S7-1）。
   *
   * ## 为什么要主动把匿名判掉
   *
   * 去掉匿名身份这件事，光「不再创建」是不够的 —— **本机可能还留着旧版本
   * 创建的匿名登录态**（localStorage 里的四把钥匙）。如果照原样读回来当成
   * 已登录，就会出现两个说不通的结果：
   *
   *   1. 用户界面上写着「已登录」，但他其实没有任何能找回数据的凭据
   *      （清掉浏览器就没了），这正是 S7 要消灭的那种「假安全」；
   *   2. 数据会落到 `ledger_<匿名uid>` 旧分区 —— 走查清单里明确要求
   *      「旧匿名分区不再被读取」。
   *
   * 所以这里把匿名身份**当作未登录**：用户回到 `ledger_guest` 分区
   * （账本 + 默认分类齐备、能看能算），想做写操作时门禁会请他登录。
   * 旧分区里的数据**不动、不删**（留作日后做迁移工具的余地）。
   */
  async function resumeFormalUser(auth) {
    const user = await resumeUser(auth)
    if (!user?.uid) return null
    return normalizeIdentity(user).isAnonymous ? null : user
  }

  /**
   * 未登录时抛出的错误（S7-1）。
   *
   * `code` 参与 `sync/errors.js` 的 `classifyError` 嗅探，归到 `auth-expired`
   * 一类 —— 但 **S7 之后引擎不再自动替用户登录**（见 S7-3）：
   * 未登录时同步根本不会启动，这条错误只是「万一走到了」的兜底。
   */
  function notSignedInError() {
    const err = new Error('[ledger] 未登录，无法读写云端数据')
    err.code = 'NOT_SIGNED_IN'
    return err
  }

  /**
   * 要求「已存在登录态」，拿不到就抛 —— **不再自动创建匿名账号**。
   *
   * ## 名字保留，语义变了（重要）
   *
   * S5 时期这个函数的语义是「**确保**有一个能读写数据的身份」，所以拿不到
   * 登录态时它会**自己 `signInAnonymously()` 开一个匿名账号**。S7 去掉了
   * 匿名身份，理由有三条：
   *
   *   1. 匿名身份的唯一钥匙是 localStorage —— 清浏览器数据就永久失联，
   *      而「登录后数据跟着手机号走」才是用户能理解的承诺；
   *   2. 它把「未登录」这个状态**藏起来了**：用户以为自己没登录，其实后台
   *      已经开了一个账号并在往云端写（新账号还会把演示账单一起推上去）；
   *   3. 首绑裁决（S5-7）整条链路都是为「匿名那份数据要不要推上云」而存在的，
   *      去掉匿名之后它自然消失。
   *
   * 于是现在的行为是：**只复用已持久化的登录态**（刷新/重进页面不该换身份），
   * 拿不到就抛 `NOT_SIGNED_IN`。谁该登录，由 UI 的门禁决定（见
   * `composables/useLoginGate.js`）。
   *
   * 并发调用共享同一个 Promise，不会同时发起两次身份读取。
   */
  async function ensureSignedIn() {
    if (currentUid) return currentUid
    if (!signInPromise) {
      signInPromise = (async () => {
        const auth = await getAuth()

        // 只认「已持久化的**正式**登录态」：刷新页面不该换一个新身份，
        // 而旧版本留下的匿名身份不算身份（见 resumeFormalUser）
        const existing = await resumeFormalUser(auth)
        if (!existing?.uid) throw notSignedInError()

        setUid(existing.uid)
        lastError = null
        emitAuth()
        return currentUid
      })().catch((e) => {
        lastError = { message: (e && e.message) || String(e), at: Date.now() }
        signInPromise = null
        emitAuth()
        throw e
      })
    }
    return signInPromise
  }

  const collectionName = (collection) => CLOUD_COLLECTIONS[collection] || collection

  /**
   * 让服务端给一批**已存在**的文档盖上裁决刻度（S4-6）。
   *
   * 返回 `Map<云端 _id, 服务端刻度毫秒>`。盖不上的（不存在 / 并发删了）就不在 Map 里，
   * 调用方按「退回客户端时间戳」处理。
   *
   * ## 为什么必须走服务端
   *
   * LWW 比的是 `updatedAt`，而那是各设备自己的客户端时钟打的。S4-2 用 `clockOffset`
   * 把「自己这份」换算到服务端时间轴，但**远端那份偏多少无从得知** —— 于是两台设备
   * 各自「只校正自己」时会双方都觉得自己更新，反复同步也不收敛（S4-6 缺陷）。
   *
   * 唯一出路是让**共享的第三方**盖章：服务端在接收时自己 `Date.now()`。客户端不能伪造，
   * 因为函数**不接受**客户端传来的时间，只接受「要盖哪些 id」。
   *
   * ## 失败必须静默降级
   *
   * 云函数没部署 / 网关不通 / 网络抖动时**不能抛错**：
   *   - 抛错会让整次推送失败，用户看到「同步失败」，而其实数据完全能推上去；
   *   - 刻度只是「让裁决更准」，缺了它退回 S4-2 的行为，比整个同步挂掉好得多。
   * 所以这里吞掉异常、返回空 Map，让调用方走降级路径。
   *
   * ## `_serverTs` 也交给它写
   *
   * 云函数在盖刻度时会**顺带刷新 `_serverTs`**（见 cloudfunctions/ledger-sync-stamp）。
   * 这样「水位线时间」和「裁决刻度」来自**同一个服务端时刻**，不会出现「刻度说 A、
   * 水位线说 B」的错位。首次推送走 `.set()`（文档还不存在，云函数盖不了）——
   * 那条路径下 `_serverTs` 仍由 `db.serverDate()` 写，两者不冲突：
   * 水位线只要求单调不减，不要求同源。
   *
   * @param {string} collection 本地集合名
   * @param {string[]} cloudIds 云端 `_id`（别名）列表
   * @returns {Promise<Map<string, number>>}
   */
  async function fetchServerStamps(collection, cloudIds) {
    const out = new Map()
    if (!isCloudApiConfigured || !cloudIds.length) return out
    try {
      const res = await fetch(cloudApiBase + CLOUD_HTTP_PATHS.SYNC_STAMP, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // ⚠️ 只传「要盖哪些」，**绝不传时间** —— 值必须由服务端生成
        body: JSON.stringify({
          updates: cloudIds.map((id) => ({ collection, id }))
        })
      })
      if (!res.ok) return out
      const body = await res.json()
      const perCollection = body?.stamps?.[collection]
      if (!perCollection) return out
      for (const [id, value] of Object.entries(perCollection)) {
        const n = Number(value)
        if (Number.isFinite(n) && n > 0) out.set(id, n)
      }
    } catch (e) {
      // 网络不通 / 网关未配置 / 响应不是 JSON —— 一律降级，不打断推送
      lastError = e
    }
    return out
  }

  /* ---------------- cloudClient 的三个方法 ---------------- */

  /**
   * 拉取增量。
   *
   * 水位线语义（与 fakeCloud 略有不同，但满足同一个不变式）：
   *   返回的 `serverTime` = **本次拉到的文档里最大的 `_serverTs`**（一条都没拉到则原样返回 since）。
   *   下次以它为 since，用 `_serverTs >= since`（**左闭**）再拉一次。
   *
   * 为什么这样就安全（S2 定下的规矩，这里换成了真实实现）：
   *   1. `_serverTs` 是**服务端写入时间**，服务端时间只会前进 ⇒ 任何「还没写」的文档
   *      将来的 `_serverTs` 一定不小于本次见过的最大值，下一次必然满足 `>= since`。
   *   2. 左闭会重复拉到「恰好等于水位」的那一两条，这是**刻意的**：宁可多拉一次，
   *      也不能漏。重复拉取无副作用 —— `syncStore.applyRemote` 走 LWW 幂等合并。
   *   3. 用数字 `0` 去比 Date 字段会一条都匹配不到（实测），所以必须 `new Date(...)`。
   *
   * ⚠️ **id 在这一层是双向映射的**（S4-7 方案 A）：
   * 调用方（引擎）只知道**本地 id**，云端只知道**别名**，两边在适配器内部换算。
   *   - 进来：`ids` 是本地 id → 换成别名去查（`_id: _.in([...别名])`）
   *   - 出去：返回的文档**不改形状**（`_id` 仍是别名），本地 id 由 `id` 业务字段承载，
   *     引擎后续走 `fromRemote()` 恢复。这里不提前替换，免得 `_id` 语义在传输层被悄悄改掉。
   */
  async function pull(collection, { since = 0, cursor = null, limit = pageLimit, ids = null } = {}) {
    const uid = await ensureSignedIn()
    const db = await getDb()
    const cmd = db.command
    const col = db.collection(collectionName(collection))

    // 精确拉取（「推送被拒后把云端版本拉回来」用）。
    // ⚠️ 这条路径**不能推进水位线**：它不是按区间扫描的，拿它的时间戳当水位
    //    会把中间还没拉过的文档永久跳过。所以 serverTime 固定返回 0。
    if (Array.isArray(ids) && ids.length) {
      // 传进来的是本地 id，先换算成云端别名
      const aliases = ids.map((id) => toCloudId(id, accountPrefixOf(uid)))
      const res = await col.where({ _id: cmd.in(aliases) }).limit(Math.max(aliases.length, 1)).get()
      return { docs: res.data || [], serverTime: 0, hasMore: false, cursor: null }
    }

    const start = Number(cursor) || 0
    const res = await col
      .where({ _serverTs: cmd.gte(new Date(Number(since) || 0)) })
      .orderBy('_serverTs', 'asc')
      .skip(start)
      .limit(limit)
      .get()

    const docs = res.data || []
    let serverTime = Number(since) || 0
    for (const doc of docs) {
      const t = toMillis(doc._serverTs)
      if (t > serverTime) serverTime = t
    }

    return {
      docs,
      serverTime,
      // 拉满一页就认为还有下一页；多跑一趟空查询比漏一页便宜
      hasMore: docs.length >= limit,
      cursor: start + docs.length
    }
  }

  /**
   * 条件 upsert。
   *
   * 云端 Web SDK 没有「带条件的写」，所以条件判断只能分两步：
   *   ① 先按 `_id`（别名）批量读回云端现有版本，拿到它们的 `updatedAt`；
   *   ② 本地这份更旧 → 进 `rejected`（**必须回给引擎**，否则本地以为推成功、
   *      两端静默分叉 —— 这个 bug 单设备永远测不出来）；否则整份覆盖。
   *
   * 返回的 `upserted` / `rejected[].id` 都是**本地 id**（不是别名）——
   * 引擎拿它们去 `outbox.markSynced`，而队列里存的是本地 id。
   * 别名只在进服务端的那一刻出现，出了函数就换算回来。
   *
   * 已知窗口（留给 S4-6）：①② 之间不是原子的，两台设备同时推同一条时理论上都
   * 可能通过检查。最终仍是 LWW，只是「谁是最后写入」由到达顺序而非 `updatedAt` 决定。
   * 要彻底消掉得靠云函数或事务。
   *
   * `options.clockOffset`（S4-2）：本地时钟偏差 = 服务端时间 - 本地时间。
   * 比较时给**本地那份**加上它，两边就换算到服务端时间轴上了 ——
   * 否则慢时钟的设备会把自己刚写的新数据判成「比云端旧」而放弃推送。
   * 只在服务端时间可信时引擎才传非 0 值。
   */
  async function push(collection, docs, { clockOffset = 0 } = {}) {
    const uid = await ensureSignedIn()
    const db = await getDb()
    const cmd = db.command
    const col = db.collection(collectionName(collection))
    const prefix = accountPrefixOf(uid)
    const offset = Number.isFinite(clockOffset) ? clockOffset : 0

    // 本地 id 是权威来源；`_id` 只作为兜底（mock/fake 云端可能只给 `_id`）
    const list = (docs || [])
      .map((d) => (d ? { doc: d, localId: toLocalId(d) } : null))
      .filter((x) => x && x.localId)
    if (!list.length) return { upserted: [], rejected: [] }

    // ① 读回云端现有版本（PRIVATE 权限下只会读到自己那份）
    //    查询用别名 —— 这里正是 S4-7 的修法：同名本地 id 在不同账号下
    //    映射到不同别名，所以新身份不会再撞上旧身份占的坑。
    const aliases = list.map((x) => toCloudId(x.localId, prefix))
    /** alias → 云端那一版的完整裁决信息 */
    const cloudVersions = new Map()
    for (let i = 0; i < aliases.length; i += pageLimit) {
      const chunk = aliases.slice(i, i + pageLimit)
      const res = await col.where({ _id: cmd.in(chunk) }).get()
      for (const doc of res.data || []) {
        cloudVersions.set(doc._id, {
          updatedAt: doc.updatedAt || 0,
          // 有服务端刻度就用它裁决（S4-6）；没有就退回客户端时间戳
          serverUpdatedAt: Number(doc.serverUpdatedAt) || 0
        })
      }
    }

    // ② 逐条裁决并写入。顺序执行：试用环境 QPS 有限，稳妥优先（首次同步最多几十条）
    const upserted = []
    const rejected = []
    for (const { doc, localId } of list) {
      const alias = toCloudId(localId, prefix)
      const cloud = cloudVersions.get(alias)

      /**
       * 裁决：云端那份更新吗？更新就拒绝本次推送，把它交回引擎去回拉。
       *
       * ⚠️ **必须与 `core/merge.js` 的 `shouldTakeRemote` 同一套规则**，
       * 否则两个方向会给出不同答案（推送说「我更新」、拉取说「你更旧」），
       * 两端就此来回打架。所以这里直接调它，而不是再写一遍比较。
       *
       * ⚠️ 最关键的一条（S4-6）：**只要云端那份有服务端刻度，本地就必须拿刻度比**。
       *    否则会出现「设备 A 只是同步得晚，就用旧内容把 B 的新内容盖掉」——
       *    因为 `.set()` 无条件覆盖，`updatedAt` 又更早，看上去毫无问题。
       *    这个 bug 正是第 3 组 3d 暴露出来的：A 的 10 覆盖了 B 的 99。
       *
       * ⚠️ **参数顺序是 `(本地, 远端)`，即 `(doc, cloud)`** —— 与 pull 侧
       *    `partitionRemote` 的 `shouldTakeRemote(localDoc, remoteDoc)` 同向。
       *    它是「**该不该采纳远端那份**」：对推送来说「远端」就是云端已有的 `cloud`。
       *    写成 `shouldTakeRemote(cloud, doc)`（参数反了）会**恰好判反**，
       *    慢时钟设备带更新内容反而被自己的旧时间戳挡住 —— 3d/3e 的真实原因。
       */
      if (cloud && shouldTakeRemote(doc, cloud, offset)) {
        rejected.push({ id: localId, cloudUpdatedAt: cloud.serverUpdatedAt || cloud.updatedAt })
        continue
      }

      const payload = stripServerMeta(doc)
      // 业务字段 `id` = 本地 id：本地库靠它还原主键（见 core/cloudId.js）。
      // 它会被 fromRemote() 读回来，所以**必须**写。
      payload.id = localId
      /**
       * 服务端接收时间：水位线的唯一依据（客户端时钟不可信）。
       *
       * ⚠️ 这里**不写 `serverUpdatedAt`**。裁决刻度由云函数在 `.set()` 之后盖 ——
       *    `.set()` 整份覆盖会把旧刻度抹掉，必须重新盖。
       *    为什么不在这一次 `.set()` 里就带上刻度：刻度必须**晚于**本次写入才成立
       *    （否则「谁更新」的答案会是上次的值）。先写内容、再盖当前刻度，顺序不能反。
       */
      payload._serverTs = db.serverDate()
      // set() = 指定 _id 的 upsert，文档已存在则整份覆盖 ⇒ 天然幂等
      await col.doc(alias).set(payload)
      upserted.push(localId)
    }

    /**
     * ③ 给**本次真正写成功的那些**盖服务端裁决刻度（S4-6）。
     *
     * 盖完这一下，其它设备拉这条文档时就能拿到一个**与写者本地时钟无关**的
     * 「内容版本时间」，跨设备裁决才落在共享时间轴上。
     *
     * ⚠️ 顺序不能提前到 ② 之前：刻度要标记「这次写入发生在服务端哪一刻」，
     *    早于 `.set()` 就会记录成上一次写入的时刻。
     *
     * ⚠️ 云函数不可用时这一步静默跳过（`stamps` 为空）—— 云端文档仍带客户端
     *    `updatedAt`，退回到 S4-2 的行为。**不因此报错**，否则「能推的数据」
     *    会被一个可选增强搞成「同步失败」。
     */
    if (upserted.length && isCloudApiConfigured) {
      const aliasesToStamp = upserted.map((id) => toCloudId(id, prefix))
      await fetchServerStamps(collection, aliasesToStamp)
    }

    return { upserted, rejected }
  }

  /**
   * 服务端当前时间（毫秒）。
   *
   * 两级实现（S4-2 起）：
   *
   * 1. **首选：HTTP 网关调 `ledger-server-time`**（真服务端时间）
   *    云函数跑在腾讯云侧，`Date.now()` 就是服务端时钟 → 这是**精确值**，
   *    可以用来做冲突裁决。
   *    为什么必须走云函数：CloudBase **Web SDK 没有「读服务端当前时间」的接口**
   *    （`serverDate()` 只能把时间写进文档，读回来的是那条文档的写入时间）。
   *
   *    ⚠️ **为什么不直接 `app.callFunction()`**：匿名登录态下会被
   *    `EXCEED_AUTHORITY`（403）拒绝 —— 云函数默认安全规则要求「登录且非匿名」，
   *    而本项目只用匿名登录。改用 `managePermissions` 放开该规则**实测无效**
   *    （接口回 Success 但复读仍是原规则）。所以走 HTTP 网关这一层，
   *    它的 `EnableAuth=false` 是真实生效的。详见 src/config/cloud.js。
   *
   * 2. **降级：取「能观察到的最新 `_serverTs`」**（下界）
   *    云函数不可用时（未配置网关基址 / 未部署 / 网络抖动）退回这里。
   *    它是**下界不是当前时间** —— 当水位线安全（只会多拉不会漏），
   *    **但不能做冲突裁决**（会误判）。降级时置 `source: 'watermark-lower-bound'`，
   *    调用方据此决定敢不敢拿它裁决。
   *
   * 返回值带 `source` 字段：`'cloud-function'` = 可信，`'watermark-lower-bound'` = 仅水位线。
   */
  async function serverTime() {
    // —— 首选：HTTP 网关 ——
    if (isCloudApiConfigured) {
      try {
        const res = await fetch(cloudApiBase + CLOUD_HTTP_PATHS.SERVER_TIME, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        })
        if (res.ok) {
          const body = await res.json()
          const ms = Number(body?.serverTime)
          if (Number.isFinite(ms) && ms > 0) {
            return { value: ms, source: 'cloud-function' }
          }
          lastError = new Error(`云函数 ${CLOUD_FUNCTIONS.SERVER_TIME} 返回结构异常`)
        } else {
          lastError = new Error(`云函数 HTTP ${res.status}`)
        }
      } catch (err) {
        lastError = err
      }
    }

    // —— 降级：水位线下界 ——
    await ensureSignedIn()
    const db = await getDb()
    const cmd = db.command
    const res = await db
      .collection(collectionName(COLLECTIONS.BILL))
      .where({ _serverTs: cmd.gte(new Date(0)) })
      .orderBy('_serverTs', 'desc')
      .limit(1)
      .get()
    const doc = (res.data || [])[0]
    return { value: doc ? toMillis(doc._serverTs) : 0, source: 'watermark-lower-bound' }
  }

  /**
   * 仅调试用：删掉**本账号**在这三个集合里的全部文档。
   *
   * 「我的 → 重置演示数据」必须连云端一起清，否则下一次同步会把刚清掉的
   * 旧数据原样拉回来，看起来像「重置按钮没生效」。
   * 只删自己的（PRIVATE 权限在服务端兜底），也只会碰 `ledger_` 前缀的集合，
   * 不会影响同环境里其它项目的数据。
   *
   * ⚠️ **为什么删两遍**（S4-7 方案 A 的遗留问题）：
   * 改方案 A 之前，云端 `_id` 就是本地 id（裸 id）；现在换成了
   * `<账号前缀>_<本地 id>` 的别名。**同一个账号**如果改版前推过一次，
   * 那些裸 id 的旧文档会留在云端 —— 只按别名删是清不掉的。
   * 所以第二遍按「有 `_serverTs` 的所有文档」全清一遍，把两种格式都覆盖到。
   */
  async function wipe() {
    await ensureSignedIn()
    const db = await getDb()
    const cmd = db.command
    const result = {}
    for (const name of Object.values(CLOUD_COLLECTIONS)) {
      let total = 0
      // 单次 remove 有条数上限，循环删到删不动为止（加个保险丝，别真跑 50 轮）
      for (let i = 0; i < 50; i += 1) {
        const res = await db.collection(name).where({ _serverTs: cmd.gte(new Date(0)) }).remove()
        const n = res?.deleted || 0
        total += n
        if (n === 0) break
      }
      result[name] = total
    }
    return result
  }

  /* ---------------- 账号体系（S5-1） ---------------- */

  /**
   * 把 session 对象里能拿到的身份信息揉成一个统一形状。
   *
   * SDK 各版本、各 provider 下这个对象长得不太一样：
   * 匿名的 `loginType` 是 `'ANONYMOUS'`，手机号登录的可能是 `'PHONE'`，
   * 手机号本身有的在 `user.phone_number`、有的在 `user.phone`。
   * 与其到处 try，不如在这里一次性归一化，**只暴露 `{ uid, isAnonymous, phone }`**。
   *
   * ⚠️ `isAnonymous` 拿不准时**倾向判为「匿名」**：UI 上「转正」入口多显示一次
   *    没有坏处，反过来（把匿名当正式账号）会让用户以为数据已经安全了，
   *    而实际上清掉浏览器就全没了 —— 这个误判的代价不对称。
   */
  function normalizeIdentity(user) {
    if (!user) return { uid: null, isAnonymous: false, phone: null }
    const loginType = String(user.loginType || user.login_type || '').toUpperCase()
    const phone = user.phone_number || user.phone || user.phoneNumber || null
    // 有手机号 ⇒ 一定是正式账号，不管 loginType 写的是什么
    const isAnonymous = phone ? false : loginType ? loginType === 'ANONYMOUS' : true
    return { uid: user.uid || null, isAnonymous, phone }
  }

  /**
   * 统一剥掉 SDK 的两种返回外壳。
   *
   * 这个 SDK 里 **两类方法的返回形状不一样**（读 `.d.ts` + 反编译 `auth/dist/index.js` 确认）：
   *   - supabase-like 那批（`signUp` / `signInWithOtp` / `signInWithPassword`）：
   *     返回 `{ data, error }`，**error 非空不一定 throw**，必须显式检查；
   *   - 老 API（`signInWithSms`）：直接返回 `LoginState`
   *     （没有 `data` 包装），失败靠 throw。
   * 与其在每处判断，不如在这里统一：有 `error` 就抛，有 `data` 就剥壳。
   */
  function unwrap(res) {
    if (res && typeof res === 'object' && 'error' in res && res.error) {
      const err = res.error
      throw err instanceof Error ? err : new Error(err.message || String(err))
    }
    if (res && typeof res === 'object' && 'data' in res && res.data !== undefined) return res.data
    return res
  }

  /**
   * 从任意形状的登录返回里捞出用户对象。
   * `LoginState.user` / `{ data: { user } }` / 裸 user 三种都见得到，统一在这里处理。
   */
  function userOf(res) {
    const payload = res && res.data !== undefined ? res.data : res
    return payload?.user || payload?.session?.user || res?.user || null
  }

  /**
   * 读当前完整身份。没登录时 `uid` 为 null。
   * ⚠️ 这个方法**不触发登录**（不会顺手开一个账号）——
   *    UI 想显示「未登录」就得能真的问到「没登录」。
   * ⚠️ **匿名身份也返回 `uid: null`**（S7-1）：见 `resumeFormalUser`。
   *    注意这时 `isAnonymous` 会是 `true`，方便排查「为什么我明明有旧匿名
   *    登录态却显示未登录」。
   */
  async function getIdentity() {
    try {
      const auth = await getAuth()
      const user = await resumeUser(auth)
      if (!user?.uid) return { uid: null, isAnonymous: false, phone: null, signedIn: false }
      const identity = normalizeIdentity(user)
      if (identity.isAnonymous) {
        return { uid: null, isAnonymous: true, phone: null, signedIn: false }
      }
      setUid(user.uid)
      return { ...identity, signedIn: true }
    } catch (e) {
      lastError = { message: (e && e.message) || String(e), at: Date.now() }
      return { uid: null, isAnonymous: false, phone: null, signedIn: false }
    }
  }

  /**
   * 发送手机验证码（S5-1）。
   *
   * ⚠️ **字段名是 `phone_number`，不是 `phone`** —— 这个 SDK 的命名不一致
   * （`signUp` / `signInWithOtp` 收 `phone`，`getVerification` 收 `phone_number`），
   * 照直觉写会静默失败。已从 `oauth/dist/auth/models.d.ts` 的
   * `GetVerificationRequest` 逐字核对过。
   *
   * ⚠️ 返回的是 `{ verification_id, is_user }`，**不是** `verificationInfo`
   * —— 这个对象本身就是 `signInWithSms` 要的 `verificationInfo` 参数值。
   * 所以这里原样返回整个 res，不要再包一层（包了反而对不上）。
   *
   * `is_user` 是服务端给的「这个号是否已注册」，登录时 SDK 内部据此走
   * signIn 还是 signUp 分支 —— 客户端不要拿它做任何判断，更不要展示给用户
   * （那等于告诉别人某个号码注册过没有）。
   *
   * 环境侧前提：控制台已开通手机短信登录，用云开发默认短信通道，
   * **不需要**配短信签名 / 模板 / 自定义 Provider。
   */
  async function sendSmsCode(phone) {
    const p = String(phone || '').trim()
    if (!p) throw new Error('[ledger] 手机号不能为空')
    const auth = await getAuth()
    const res = await auth.getVerification({ phone_number: p })
    return {
      verificationInfo: {
        verification_id: res?.verification_id || '',
        is_user: Boolean(res?.is_user)
      }
    }
  }

  /**
   * 手机验证码登录（S5-1）。
   *
   * ⚠️ `signInWithSms` 是**老 API**，返回 `LoginState`（不是 `{ data, error }`），
   * 内部委托给 `signInWithUsername({ verificationInfo, verificationCode, username: phone,
   * loginType: 'sms' })`，再调 `verify()` 校验 → `is_user` 为真走 signIn、
   * 否则走 signUp。**它不会自己发验证码**，所以必须先 `sendSmsCode`。
   *
   * 这是**换账号**：登录成功后 uid 变了，云端数据也换成那个账号的。
   * 调用方（account store）必须跟着重建本地数据层（库分区，S5-5），
   * 否则新账号会读到上一个账号留在同一个 IndexedDB 库里的数据与队列。
   *
   * @param {object} params
   * @param {string} params.phone
   * @param {string} params.code 收到的验证码
   * @param {{verification_id: string, is_user: boolean}} params.verificationInfo
   *   `sendSmsCode` 返回的那个（**必传**，缺了 `verify()` 会因 verification_id 为空而失败）
   */
  async function signInWithSms({ phone, code, verificationInfo } = {}) {
    const p = String(phone || '').trim()
    const c = String(code || '').trim()
    if (!p || !c) throw new Error('[ledger] 手机号与验证码都不能为空')
    const auth = await getAuth()
    const res = await auth.signInWithSms({
      verificationInfo: verificationInfo || { verification_id: '', is_user: false },
      verificationCode: c,
      phoneNum: p
    })
    const user = userOf(res) || auth.currentUser
    setUid(user?.uid || null)
    signInPromise = null // 身份变了，缓存的身份读取 Promise 作废
    lastError = null
    emitAuth()
    if (!currentUid) throw new Error('[ledger] 手机号登录成功但拿不到 uid')
    return { ...normalizeIdentity(user), signedIn: true }
  }

  /* ---------------- 关于「匿名转正」（S7 已移除，经验保留） ----------------

   * S5 时期这里有 `prepareUpgrade` / `confirmUpgrade` 两个方法，
   * 把**当前匿名会话的 access_token** 当 `anonymous_token` 传给 `signUp`，
   * 让服务端把手机号绑到同一个 uid 上（数据原地保留）。
   *
   * S7 去掉匿名身份后它就**没了意义**：没有匿名会话，也就没有
   * 东西可以“转”。于是两个方法一并删除，登录只剩 `signInWithSms` 一条路。
   *
   * 但当初踩出来的两个坑值得留在这里（将来若重新引入第三方身份模式会再撞上）：
   *
   *   1. **必须传 `phone` 而不是 `phone_number`**。`auth.signUp` 的分支判断是
   *      “有没有 phone_number / verification_code /…”：传 `phone_number` 会走“直接注册”
   *      分支，`anonymous_token` 当场失效，用户看到的是“账全没了”。
   *   2. **不能用独立的 `auth.verifyOtp`**：它额外要 `messageId`，必须用
   *      `signUp` 返回值上那个闭包住验证会话的回调。
   *   3. 一台**一只手机号只能有一条短信**：UI 自己发一条、`signUp` 内部又发一条，
   *      验证码必然对不上，而且同号一分钟内连发两条会撞频控。
   *
   * 同样值得记住的一条真机实测结论（2026-10-01）：**真 SDK 的转正会换 uid**
   * （与 fake SDK “uid 不变”的前提相反），但服务端仍是同一条账号记录、数据原属主可读。
   * 这正是 S4-7「本地 id 与账号解耦」+ 稳定代理 + `rebuildForAccount`
   * 这三件事共同保住的：换了 uid，本地分区重建后全量回拉也能把账拿回来。
   */

  /**
   * 退出登录。
   *
   * ⚠️ 这里**只登出，不碰任何数据**（本地与云端都保留）。
   *    「退出后本地数据怎么处置」是一个产品决策（清掉？保留？下次登录还看得见？），
   *    属于 S5-4，不该由适配器替用户决定。
   *    登出后 uid 归零，调用方据此把本地切回「未登录/匿名」分区。
   *
   * ⚠️ 登出**失败也要把本地 uid 清掉**。SDK 的 `signOut()` 在 token 已过期等
   *    情况下会返回 `{error}` 或抛错，但用户的意图是「我要退出」——
   *    本地还留着 uid 会出现「界面显示已登录、实际已经登出」的错位，
   *    下一次同步会以旧身份发请求，反而更难排查。
   *    所以这里吞掉异常，只记 lastError，uid 一律清。
   */
  async function signOut() {
    try {
      const auth = await getAuth()
      if (typeof auth.signOut === 'function') unwrap(await auth.signOut())
    } catch (e) {
      lastError = { message: (e && e.message) || String(e), at: Date.now() }
    }
    setUid(null)
    signInPromise = null
    emitAuth()
    return { signedIn: false, error: lastError }
  }

  return {
    name: 'cloudbase',
    env,

    pull,
    push,
    serverTime,

    /** 仅调试用 */
    wipe,

    /** 显式登录（一般不用调，数据方法会自己确保） */
    ensureSignedIn,

    /* ---- 账号体系（S5-1） ---- */
    /** 发手机验证码 */
    sendSmsCode,
    /** 手机号验证码登录 / 注册（会换 uid，调用方需重建数据层） */
    signInWithSms,
    /** 退出登录（不动数据） */
    signOut,
    /** 读当前身份，不触发登录 */
    getIdentity,

    get uid() {
      return currentUid
    },
    /**
     * 是否已登录（S7-3）。
     *
     * `false` 是给同步引擎看的硬信号：**别发请求**。它只在「确定没有登录态」
     * 时为 `false`，所以引擎用 `=== false` 判（适配器没实现时是 `undefined`，
     * 那种情况下不拦）。
     */
    get signedIn() {
      return Boolean(currentUid)
    },
    /** 当前账号前缀（云端 `_id` 别名用）。未登录时 null */
    get accountPrefix() {
      return currentPrefix
    },
    get lastError() {
      return lastError
    },
    /** 订阅登录态变化。订阅时立刻回调一次当前状态 */
    onAuthChange(cb) {
      authListeners.add(cb)
      try {
        cb({ uid: currentUid, accountPrefix: currentPrefix, env, error: lastError })
      } catch (e) {
        /* 同上 */
      }
      return () => authListeners.delete(cb)
    }
  }
}
