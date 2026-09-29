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

  async function pullAll() {
    const since = meta ? (await meta.get(watermarkKey)) || 0 : 0
    const applied = []
    let watermark = since
    for (const collection of collections) {
      let cursor = null
      let pages = 0
      do {
        const page = await cloud.pull(collection, { since, cursor, limit: pageLimit })
        if (page.docs.length) {
          await store.applyRemote(collection, page.docs)
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

  async function pushPending() {
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

      const result = await cloud.push(collection, docs)
      const okIds = new Set(result.upserted || [])
      await outbox.markSynced(group.filter((e) => okIds.has(e.docId)).map((e) => e.id))
      upserted.push(...(result.upserted || []))
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
  async function resolveRejected(rejected) {
    const applied = []
    const byCollection = new Map()
    for (const item of rejected) {
      if (!byCollection.has(item.collection)) byCollection.set(item.collection, [])
      byCollection.get(item.collection).push(item.id)
    }

    for (const [collection, ids] of byCollection) {
      const page = await cloud.pull(collection, { ids, limit: Math.max(ids.length, 1) })
      if (page.docs.length) {
        await store.applyRemote(collection, page.docs)
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

  async function run(reason) {
    setState(SYNC_STATE.SYNCING)
    try {
      // ① pull 在前：先合并云端的更新，再推本地未送出的
      //    反过来（先 push）会用本地的旧版本覆盖云端的较新版本，
      //    另一台设备的修改就被无声抹掉了。
      const pulled = await pullAll()

      // ② push 未送出的（条件 upsert，云端更旧才覆盖）
      const pushed = await pushPending()

      // ③ 被拒的立刻回拉，避免两端分叉
      const refetched = pushed.rejected.length ? await resolveRejected(pushed.rejected) : []

      // ④ 压缩队列：清掉已同步条目，否则队列会无限长
      await outbox.compact()
      await refreshPending()

      // ⑤ 落水位、广播
      lastSyncAt = pulled.watermark
      if (meta) await meta.set(watermarkKey, lastSyncAt)
      retryCount = 0
      lastError = null
      setState(SYNC_STATE.IDLE)

      return {
        ok: true,
        reason,
        pushed: pushed.upserted.length,
        pulled: pulled.applied.length + refetched.length,
        rejected: pushed.rejected
      }
    } catch (e) {
      lastError = { message: (e && e.message) || String(e), at: now(), reason }
      retryCount += 1
      try {
        await outbox.bumpRetryAll()
        await refreshPending()
      } catch (inner) {
        /* 记重试次数失败不该盖掉真正的同步错误 */
      }
      setState(SYNC_STATE.ERROR)
      scheduleRetry()
      return { ok: false, reason, error: lastError, retry: retryCount }
    }
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
