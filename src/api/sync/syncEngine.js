/**
 * 同步引擎（调度骨架，不关心云端是真是假）
 * ------------------------------------------------------------
 * 它只回答一个问题：**什么时候该同步、失败了怎么办**。
 * 「怎么跟云端说话」交给 cloudClient.js 定义的接口，
 * S2 用 fakeCloud、S3 换成 cloudbaseAdapter，这个文件一行都不用改。
 *
 * 四态状态机：
 *   idle     没有进行中的同步
 *   syncing  正在 pull / push
 *   error    上次同步失败，保留 lastError
 *   offline  浏览器报告离线，压根不发请求（省电、省云资源点、也不污染重试计数）
 *
 * 防重入是唯一的闸门：syncing 期间再调 sync()，返回的是**同一个 in-flight
 * Promise**，而不是并发发第二次请求。启动、online、写后 debounce、手动按钮
 * 可能在同一个 tick 内一起触发，靠的就是这一条。
 * （反例：调用前判一下 state === 'syncing' 就 return —— 调用方拿不到结果，
 *   也没法 await，语义是错的。）
 *
 * 单次 sync 的顺序是 pull 在前、push 在后，理由见 run() 里的注释。
 */

import { COLLECTIONS } from '../contract.js'
import { CLOUD_PAGE_LIMIT } from './cloudClient.js'
import { SYNC_ERROR_KIND, toSyncError } from './errors.js'

export const SYNC_STATE = {
  IDLE: 'idle',
  SYNCING: 'syncing',
  ERROR: 'error',
  OFFLINE: 'offline'
}

const DEFAULT_COLLECTIONS = [COLLECTIONS.LEDGER, COLLECTIONS.CATEGORY, COLLECTIONS.BILL]

/**
 * 指数退避：2s → 4s → 8s → 16s → 32s，超过 maxRetry 次返回 null（不再自动重试）。
 * 单独抽成纯函数是为了能被直接断言 —— 退避表这种东西用假定时器去倒推太脆。
 */
export function backoffDelay(retry, { baseDelay = 2000, maxDelay = 60000, maxRetry = 5 } = {}) {
  if (!Number.isFinite(retry) || retry <= 0 || retry > maxRetry) return null
  return Math.min(baseDelay * 2 ** (retry - 1), maxDelay)
}

export function createSyncEngine({
  outbox,
  store,
  cloud = null,
  collections = DEFAULT_COLLECTIONS,
  /** 键值仓（存水位线）：{ get(key), set(key, value) }，可为空（则不持久化水位） */
  meta = null,
  watermarkKey = 'syncWatermark',
  debounceMs = 2000,
  maxRetry = 5,
  baseDelay = 2000,
  maxDelay = 60000,
  pageLimit = CLOUD_PAGE_LIMIT,
  maxPages = 50,
  now = () => Date.now(),
  timer = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
  isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false)
} = {}) {
  let state = SYNC_STATE.IDLE
  let lastError = null
  let lastSyncAt = 0
  let pendingCache = 0
  let retryCount = 0
  /**
   * 连续失败次数。与 `retryCount` 分开：后者会随重试队列语义走动，
   * 这个只回答「是不是一直没好」，用于 UI 决定要不要显示持续失败提示。
   */
  let consecutiveFailures = 0
  /** 本地时钟相对服务端的偏移（S4-2）。仅用于展示与断言，实际比较在传入适配器时用 */
  let lastClockOffset = 0
  /** 这次偏移的来源：'cloud-function' 才算可信 */
  let lastClockSource = null
  /** 这一轮是否已经试过重新登录，避免登录本身坏掉时打成死循环 */
  let reauthTried = false
  let inFlight = null
  let debounceTimer = null
  let retryTimer = null
  let offOutbox = null
  let started = false
  const listeners = new Set()

  function snapshot() {
    return {
      state,
      pendingCount: pendingCache,
      lastSyncAt,
      lastError,
      retry: retryCount,
      consecutiveFailures,
      clockOffset: lastClockOffset,
      clockSource: lastClockSource,
      online: isOnline()
    }
  }

  function emit() {
    const payload = snapshot()
    listeners.forEach((cb) => {
      try {
        cb(payload)
      } catch (e) {
        /* 订阅者的异常不该影响同步本身 */
      }
    })
  }

  function setState(next) {
    if (state === next) return
    state = next
    emit()
  }

  async function refreshPending() {
    pendingCache = await outbox.pendingCount()
    return pendingCache
  }

  /* ---------------- 单次同步 ---------------- */

  async function pullAll(clockOffset = 0) {
    const since = meta ? (await meta.get(watermarkKey)) || 0 : 0
    const applied = []
    let watermark = since
    for (const collection of collections) {
      let cursor = null
      let pages = 0
      do {
        const page = await cloud.pull(collection, { since, cursor, limit: pageLimit })
        if (page.docs.length) {
          await store.applyRemote(collection, page.docs, clockOffset)
          applied.push(...page.docs)
        }
        // 新水位取「云端给的快照时间」，不是本地时钟，也不是取到的最大 updatedAt。
        // 它由云端在查询开始前决定，所以查询期间产生的新写入一定会大于它，
        // 留给下一次拉取 —— 不会漏（详见 fakeCloud 里 _serverTs 的注释）。
        if (page.serverTime > watermark) watermark = page.serverTime
        cursor = page.hasMore ? page.cursor : null
        pages += 1
      } while (cursor !== null && pages < maxPages)
    }
    return { applied, watermark }
  }

  /**
   * `clockOffset` 要透传给适配器：**推送的裁决也在比客户端时钟**。
   * 慢时钟的设备会把自己「刚写的新数据」判成比云端旧而放弃推送 ——
   * 这正是 S4-2 要修的那个缺陷，所以偏移必须一路传到 adapter 的比较处。
   */
  async function pushPending(clockOffset = 0) {
    const entries = await outbox.pending()
    const upserted = []
    const rejected = []
    if (!entries.length) return { upserted, rejected }

    const byCollection = new Map()
    for (const entry of entries) {
      if (!byCollection.has(entry.collection)) byCollection.set(entry.collection, [])
      byCollection.get(entry.collection).push(entry)
    }

    for (const [collection, group] of byCollection) {
      // 推的是「当前本地的文档」，不是入队时的 payload 快照：
      // 否则一条已被远端否决的旧快照会被原样推上去，把云端的正确版本又改回去。
      const docs = []
      for (const entry of group) {
        const doc = await store.get(collection, entry.docId)
        if (doc) docs.push(doc)
      }

      if (!docs.length) {
        // 本地已经没有这条了 → 作废条目，否则它会永远卡在队列里重试
        await outbox.drop(group.map((e) => e.id))
        continue
      }

      const result = await cloud.push(collection, docs, { clockOffset })
      const okIds = new Set(result.upserted || [])
      await outbox.markSynced(group.filter((e) => okIds.has(e.docId)).map((e) => e.id))
      upserted.push(...(result.upserted || []))

      /**
       * 把服务端盖的裁决刻度**写回本地副本**（S4-6 收敛的最后一环）。
       *
       * 服务端盖的刻度只有服务端知道，写者自己的本地副本不会自动获得它。
       * 若本地副本没有刻度，写者下次拉取时「本地无刻度 vs 远端有刻度」比不了，
       * 只能退回客户端 `updatedAt` —— 两台时钟不一致的设备又回到**互相觉得
       * 自己更新**的死局。有了这一刻度，两边才真正落在同一条时间轴上。
       *
       * ⚠️ 这是**服务端元数据**，不是用户内容：
       *    - 不走 outbox（否则会自己推自己，且刻度是服务端生成的、不该由客户端推）；
       *    - 不碰 `updatedAt`（内容版本是客户端时钟打的，保持原样）；
       *    - 失败/不可用（`stamps` 为空）时静默跳过，退回 S4-2 行为。
       *   所以用专门的 `applyStamps`，而不是复用写路径。
       */
      const stamps = result.stamps || {}
      const stampIds = Object.keys(stamps)
      if (stampIds.length && typeof store.applyStamps === 'function') {
        await store.applyStamps(collection, stamps)
      }

      ;(result.rejected || []).forEach((r) => rejected.push({ ...r, collection }))
    }

    return { upserted, rejected }
  }

  /**
   * 处理「被云端拒绝」的推送。
   * 云端拒绝意味着它那边有一份更新的版本 —— 必须把云端版本拉回来覆盖本地，
   * 并作废那个 outbox 条目。少了这一步，本地会以为自己推成功了，
   * 两端就此静默分叉（这个 bug 单设备永远测不出来）。
   */
  async function resolveRejected(rejected, clockOffset = 0) {
    const applied = []
    const byCollection = new Map()
    for (const item of rejected) {
      if (!byCollection.has(item.collection)) byCollection.set(item.collection, [])
      byCollection.get(item.collection).push(item.id)
    }

    for (const [collection, ids] of byCollection) {
      const page = await cloud.pull(collection, { ids, limit: Math.max(ids.length, 1) })
      if (page.docs.length) {
        await store.applyRemote(collection, page.docs, clockOffset)
        applied.push(...page.docs)
      }
      const entries = await outbox.pending()
      await outbox.drop(
        entries
          .filter((e) => e.collection === collection && ids.includes(e.docId))
          .map((e) => e.id)
      )
    }
    return applied
  }

  /* ---------------- 服务端时间与时钟校正（S4-2） ---------------- */

  /**
   * 取一次服务端时间，算出**本地时钟的偏差**，供合并裁决使用。
   *
   *     clockOffset = 服务端时间 - 本地时间
   *
   * `> 0` 表示本机时钟**慢**（要把它往前推）；`< 0` 表示快。
   *
   * ⚠️ **只在服务端时间可信时才返回非 0**：
   * `serverTime()` 的 `source` 为 `'cloud-function'` 才是真服务端时钟；
   * `'watermark-lower-bound'` 是「能观察到的最新 `_serverTs`」，是**下界**，
   * 拿它算偏移会把本地时钟推慢、反而制造新的错判 → 这种情况返回 0。
   *
   * 失败不影响同步本身：时钟校正只是「让裁决更准」，不是必需品。
   * 拿不到就返回 0，退回原来的纯客户端时钟比较。
   */
  async function resolveClockOffset() {
    if (!cloud || typeof cloud.serverTime !== 'function') return { offset: 0, source: null }
    try {
      // 往返中点修正：一次请求有 RTT，用「发出前」和「收到后」的本地时间取中点，
      // 否则单程延迟会整个算进偏移里（网络慢时能差出上百毫秒）。
      const t0 = now()
      const res = await cloud.serverTime()
      const t1 = now()
      const value = Number(res?.value)
      const source = res?.source || null
      if (!Number.isFinite(value) || value <= 0) return { offset: 0, source }
      if (source !== 'cloud-function') {
        // 不可信：宁可不校正，也不要引入新的偏差
        return { offset: 0, source }
      }
      const localMid = t0 + (t1 - t0) / 2
      return { offset: value - localMid, source }
    } catch (e) {
      return { offset: 0, source: null }
    }
  }

  async function run(reason) {
    setState(SYNC_STATE.SYNCING)
    try {
      // ⓪ 先取时钟偏移：下面 pull 合并时要用它把两边换算到服务端时间轴上。
      //    放在 pull 之前是必须的 —— 合并已经发生了再知道偏移就晚了。
      const clock = await resolveClockOffset()
      lastClockOffset = clock.offset
      lastClockSource = clock.source

      // ① pull 在前：先合并云端的更新，再推本地未送出的
      //    反过来（先 push）会用本地的旧版本覆盖云端的较新版本，
      //    另一台设备的修改就被无声抹掉了。
      const pulled = await pullAll(clock.offset)

      // ② push 未送出的（条件 upsert，云端更旧才覆盖）
      const pushed = await pushPending(clock.offset)

      // ③ 被拒的立刻回拉，避免两端分叉
      const refetched = pushed.rejected.length ? await resolveRejected(pushed.rejected, clock.offset) : []

      // ④ 压缩队列：清掉已同步条目，否则队列会无限长
      await outbox.compact()
      await refreshPending()

      // ⑤ 落水位、广播
      lastSyncAt = pulled.watermark
      if (meta) await meta.set(watermarkKey, lastSyncAt)
      retryCount = 0
      lastError = null
      consecutiveFailures = 0
      setState(SYNC_STATE.IDLE)

      return {
        ok: true,
        reason,
        pushed: pushed.upserted.length,
        pulled: pulled.applied.length + refetched.length,
        rejected: pushed.rejected,
        clockOffset: clock.offset,
        clockSource: clock.source
      }
    } catch (e) {
      return handleSyncFailure(e, reason)
    }
  }

  /**
   * 同步失败的统一处置（S4-4）。
   *
   * 分类 → 按策略决定**要不要重试、要不要先重新登录、要不要打扰用户**。
   * 三件事分开做，才不会出现「登录失效却无限退避」这种永远好不了的循环。
   */
  async function handleSyncFailure(e, reason) {
    const err = toSyncError(e, { online: isOnline() })
    const policy = err.policy
    lastError = { message: err.message, kind: err.kind, at: now(), reason, label: policy.label }
    consecutiveFailures += 1

    // 队列的重试计数只在「重试有意义」时才加。
    // 配额用完、权限被拒、主键冲突这类，加重试数只会让队列看起来像是「试过了但网差」。
    if (policy.retryable) {
      retryCount += 1
      try {
        await outbox.bumpRetryAll()
      } catch (inner) {
        /* 记重试次数失败不该盖掉真正的同步错误 */
      }
    }
    try {
      await refreshPending()
    } catch (inner) {
      /* 同上 */
    }

    // 登录态失效：退避重试永远好不了，必须**先重新登录**再立刻重试一次。
    // 只重试一次，避免登录本身也坏掉时打成死循环。
    if (policy.needsReauth && !reauthTried) {
      reauthTried = true
      const ok = await tryReauth()
      if (ok) {
        setState(SYNC_STATE.IDLE)
        // 重新登录后立刻再来一轮（不排队退避：刚登录完，网和身份都是新的）
        return sync({ reason: `${reason}:reauth`, manual: true })
      }
    }

    setState(policy.silent || err.kind === SYNC_ERROR_KIND.OFFLINE ? SYNC_STATE.OFFLINE : SYNC_STATE.ERROR)
    if (policy.retryable) scheduleRetry()
    else if (retryTimer) {
      // 不可重试的类别：把已排队的退避取消掉，否则它醒过来还会再打一次
      timer.clearTimeout(retryTimer)
      retryTimer = null
    }

    return {
      ok: false,
      reason,
      error: lastError,
      kind: err.kind,
      retry: retryCount,
      retryable: policy.retryable
    }
  }

  /** 尝试重新登录（匿名续期）。适配器有 ensureSignedIn 就用它 */
  async function tryReauth() {
    try {
      if (cloud && typeof cloud.ensureSignedIn === 'function') {
        await cloud.ensureSignedIn()
        return true
      }
    } catch (e) {
      /* 重新登录也失败：交给下一轮退避 */
    }
    return false
  }

  /* ---------------- 对外接口 ---------------- */

  function sync(options = {}) {
    const { reason = 'manual', manual = false } = options

    // 防重入放在最前面：四种触发源都收敛到这里
    if (inFlight) return inFlight

    if (!cloud) return Promise.resolve({ ok: false, skipped: true, reason: 'no-cloud' })

    if (!manual && !isOnline()) {
      setState(SYNC_STATE.OFFLINE)
      return Promise.resolve({ ok: false, skipped: true, reason: 'offline' })
    }

    const p = run(reason)
    inFlight = p
    const clear = () => {
      if (inFlight === p) inFlight = null
    }
    p.then(clear, clear)
    return p
  }

  /** 写操作后的防抖调度；由 outbox 的变更通知唤醒 */
  function schedule() {
    if (debounceTimer) timer.clearTimeout(debounceTimer)
    debounceTimer = timer.setTimeout(() => {
      debounceTimer = null
      sync({ reason: 'debounced' })
    }, debounceMs)
    return debounceTimer
  }

  function scheduleRetry() {
    if (retryTimer) timer.clearTimeout(retryTimer)
    const delay = backoffDelay(retryCount, { baseDelay, maxDelay, maxRetry })
    if (delay === null) {
      // 到上限就不再自动重试，只等外部触发：手动 / online / 下次写入
      retryTimer = null
      return null
    }
    retryTimer = timer.setTimeout(() => {
      retryTimer = null
      sync({ reason: 'retry' })
    }, delay)
    return delay
  }

  function handleOnline() {
    setState(SYNC_STATE.IDLE)
    // manual: true —— 刚恢复网络时 navigator.onLine 可能还没翻过来
    sync({ reason: 'online', manual: true })
  }

  function handleOffline() {
    setState(SYNC_STATE.OFFLINE)
  }

  function stop() {
    started = false
    if (offOutbox) {
      offOutbox()
      offOutbox = null
    }
    if (debounceTimer) {
      timer.clearTimeout(debounceTimer)
      debounceTimer = null
    }
    if (retryTimer) {
      timer.clearTimeout(retryTimer)
      retryTimer = null
    }
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
    return true
  }

  function start() {
    if (started) return stop
    started = true

    // 适配器只往 outbox 里丢条目，不认识 syncEngine；
    // 这里是依赖反转的接缝 —— 通知一来就刷新待推数并安排一次防抖同步。
    offOutbox = outbox.onChange(() => {
      refreshPending().then(emit, () => {})
      schedule()
    })

    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('online', handleOnline)
      window.addEventListener('offline', handleOffline)
    }

    refreshPending().then(emit, () => {})
    sync({ reason: 'startup' })
    return stop
  }

  return {
    sync,
    schedule,
    start,
    stop,

    /** 订阅状态变化。订阅时会立刻回调一次当前状态，方便 UI 初始化 */
    onStateChange(cb) {
      listeners.add(cb)
      try {
        cb(snapshot())
      } catch (e) {
        /* 同上 */
      }
      return () => listeners.delete(cb)
    },

    snapshot,

    get state() {
      return state
    },
    get pendingCount() {
      return pendingCache
    },
    get lastSyncAt() {
      return lastSyncAt
    },
    get lastError() {
      return lastError
    },
    get retry() {
      return retryCount
    },

    /** 仅调试用 */
    async resetWatermark() {
      if (meta) await meta.set(watermarkKey, 0)
      retryCount = 0
      lastError = null
      return true
    }
  }
}
