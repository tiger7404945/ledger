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
 */

import { COLLECTIONS } from '../contract.js'
import { CLOUD_PAGE_LIMIT } from '../sync/cloudClient.js'
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
   * 确保已登录（匿名）。所有数据方法的第一句都是它。
   * 并发调用共享同一个 Promise，不会同时发起两次登录。
   */
  async function ensureSignedIn() {
    if (currentUid) return currentUid
    if (!signInPromise) {
      signInPromise = (async () => {
        const app = await getApp()
        const auth = app.auth({ persistence })

        // 先看有没有已持久化的登录态：刷新页面不该换一个新身份
        const existing = await resumeUser(auth)
        if (existing?.uid) {
          setUid(existing.uid)
          lastError = null
          emitAuth()
          return currentUid
        }

        const res = await auth.signInAnonymously()
        setUid(res?.user?.uid || auth.currentUser?.uid || null)
        lastError = null
        emitAuth()
        if (!currentUid) throw new Error('[ledger] 匿名登录成功但拿不到 uid')
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
   */
  async function push(collection, docs) {
    const uid = await ensureSignedIn()
    const db = await getDb()
    const cmd = db.command
    const col = db.collection(collectionName(collection))
    const prefix = accountPrefixOf(uid)

    // 本地 id 是权威来源；`_id` 只作为兜底（mock/fake 云端可能只给 `_id`）
    const list = (docs || [])
      .map((d) => (d ? { doc: d, localId: toLocalId(d) } : null))
      .filter((x) => x && x.localId)
    if (!list.length) return { upserted: [], rejected: [] }

    // ① 读回云端现有版本（PRIVATE 权限下只会读到自己那份）
    //    查询用别名 —— 这里正是 S4-7 的修法：同名本地 id 在不同账号下
    //    映射到不同别名，所以新身份不会再撞上旧身份占的坑。
    const aliases = list.map((x) => toCloudId(x.localId, prefix))
    const cloudUpdatedAt = new Map()
    for (let i = 0; i < aliases.length; i += pageLimit) {
      const chunk = aliases.slice(i, i + pageLimit)
      const res = await col.where({ _id: cmd.in(chunk) }).get()
      for (const doc of res.data || []) {
        cloudUpdatedAt.set(doc._id, doc.updatedAt || 0)
      }
    }

    // ② 逐条裁决并写入。顺序执行：试用环境 QPS 有限，稳妥优先（首次同步最多几十条）
    const upserted = []
    const rejected = []
    for (const { doc, localId } of list) {
      const alias = toCloudId(localId, prefix)
      const localTs = doc.updatedAt || 0
      const remoteTs = cloudUpdatedAt.has(alias) ? cloudUpdatedAt.get(alias) : null

      if (remoteTs !== null && localTs < remoteTs) {
        rejected.push({ id: localId, cloudUpdatedAt: remoteTs })
        continue
      }

      const payload = stripServerMeta(doc)
      // 业务字段 `id` = 本地 id：本地库靠它还原主键（见 core/cloudId.js）。
      // 它会被 fromRemote() 读回来，所以**必须**写。
      payload.id = localId
      // 服务端接收时间：水位线的唯一依据（客户端时钟不可信）
      payload._serverTs = db.serverDate()
      // set() = 指定 _id 的 upsert，文档已存在则整份覆盖 ⇒ 天然幂等
      await col.doc(alias).set(payload)
      upserted.push(localId)
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
    get uid() {
      return currentUid
    },
    get lastError() {
      return lastError
    },
    /** 订阅登录态变化。订阅时立刻回调一次当前状态 */
    onAuthChange(cb) {
      authListeners.add(cb)
      try {
        cb({ uid: currentUid, env, error: lastError })
      } catch (e) {
        /* 同上 */
      }
      return () => authListeners.delete(cb)
    }
  }
}
