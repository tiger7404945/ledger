/**
 * 假云端（测试与本地调试用）
 * ------------------------------------------------------------
 * 一个内存 Map，实现 cloudClient.js 定义的那套接口 —— 与 S3 的真云端
 * 一模一样。这样调 syncEngine 的调度逻辑时，永远不用怀疑网络。
 *
 * 除了接口本身，它还多带了几件「真云端没有、但测试必备」的能力：
 *   as(openid)      切换身份（模拟换账号 / 换设备登录）→ 用来验证数据隔离
 *   条件 upsert     与真云端同语义：本地更旧就拒绝，并回 rejected
 *   分页游标        可以造 250 条数据验证循环拉取
 *   _failNext(n)    接下来 n 次调用抛错 → 用来验证离线补推与退避重试
 *   _calls()        调用计数 → 用来验证防重入（并发 5 次只应发 1 轮）
 *   _skew(ms)       服务端时间偏移 → 只为把「客户端时钟不可信」这个问题
 *                   暴露出来，S2 不对它做断言，留给 S4 用服务端时间裁决
 *
 *   _serverTimeSource(src)  把 serverTime() 的 source 改成
 *                   'watermark-lower-bound'，用来验证「云函数不可用时的降级」
 *
 *   ⚠️ **`push` 会给写入的文档盖 `serverUpdatedAt`**（S4-6）。
 *   这与真云端 `cloudbaseAdapter` 调用 `ledger-sync-stamp` 云函数的语义一致 ——
 *   假云端必须跟着做，否则测试永远测不出跨设备裁决到底通没通。
 *   用 `_noServerStamp(true)` 可以关掉它，模拟「云函数不可用 → 没盖上刻度」，
 *   用来验证降级路径确实能退回 S4-2 的老行为。
 *
 * 隔离是怎么实现的：push 时给文档打上当前身份的 `_openid`，pull 时只返回
 * `_openid` 匹配的文档。**注意这只是「客户端自觉」** —— 真实的隔离靠服务端
 * 安全规则，假云端证明不了那件事（见 phase2-backend-plan.md 的 S3 验收）。
 */

import { shouldTakeRemote } from '../core/merge.js'

export function createFakeCloud({ latency = 0, pageSize = 100, clock = () => Date.now() } = {}) {  /** key = `${openid}\0${collection}\0${_id}`，一个后端被所有身份共用 */
  const rows = new Map()
  const ctx = {
    failures: 0,
    failure: null,
    /** 持续失败（不会自愈）。用 `_failAlways({ kind, message })` 设置 */
    persistentFailure: null,
    skew: 0,
    /** serverTime() 返回的 source；改成 'watermark-lower-bound' 可模拟云函数不可用 */
    serverTimeSource: 'cloud-function',
    /** true = 不盖 serverUpdatedAt（模拟「S4-6 的云函数不可用 → 降级」） */
    noServerStamp: false,
    calls: { push: 0, pull: 0, serverTime: 0 },
    log: []
  }

  const keyOf = (openid, collection, id) => `${openid}\u0000${collection}\u0000${id}`
  const prefixOf = (openid, collection) => `${openid}\u0000${collection}\u0000`

  const tick = () => (latency > 0 ? new Promise((r) => setTimeout(r, latency)) : Promise.resolve())

  function maybeFail() {
    if (ctx.failures > 0) {
      ctx.failures -= 1
      throw ctx.failure || new Error('[ledger] 假云端：模拟网络失败')
    }
    // 持续失败的模式：用于验证「不可重试的类别不该继续退避」
    // （登录失效、配额用完这类，重试永远好不了）
    if (ctx.persistentFailure) {
      const e = ctx.persistentFailure
      if (e.kind) {
        const err = new Error(e.message || `[ledger] 假云端：持续失败 ${e.kind}`)
        err.kind = e.kind
        throw err
      }
      throw e
    }
  }

  /**
   * 服务端时钟：**严格单调递增**。
   * 真实的服务端时间也只会前进；这里额外保证「同一毫秒内的多次写入一定拿到
   * 不同的时间戳」，否则水位线会把同一毫秒里的更新判成「已经拉过了」而漏掉。
   *
   * ⚠️ 单调只管「不倒退」，**不能凭空超越底层时钟**。
   * 早期写法是无条件 `serverClock + 1`，这会让 `serverNow()` 每被调用一次就
   * 比 `clock()` 往前多爬 1ms：一次同步要调它 4 次（serverTime + 3 个集合的
   * pull 快照），几十轮下来就爬上几百毫秒。后果是引擎算出的
   * `clockOffset = 服务端时间 - 本地时间` 被这个漂移污染 —— 于是「本地时钟
   * 倒退」场景里，本地时间戳被推得比云端还新，LWW 裁决方向整个反过来
   * （14 组「拒绝后回拉」失效的真正原因）。
   *
   * 正确语义是：**同一时刻（`clock() + skew` 没变）的重复调用，返回同一个值**；
   * 只有「时钟倒退」或「值已被占用」时才 +1 追赶。这与真实服务端一致 ——
   * 数据库的 serverDate 也不会因为多查了两次就当作时间前进了。
   */
  let serverClock = 0
  let serverClockBase = null
  const serverNow = () => {
    const base = clock() + ctx.skew
    if (serverClockBase === null || base > serverClockBase) {
      // 时钟真的前进了（或首次调用）：跳到新的基准
      serverClock = base
      serverClockBase = base
    } else if (serverClock < base) {
      // 时钟倒退过、但还没被追平：先补回 base，避免时间轴出现空洞
      serverClock = base
    }
    // base 没变时返回同一个值：同一毫秒内的多次读取是同一个时刻
    return serverClock
  }

  function clientFor(openid) {
    return {
      openid,

      async push(collection, docs, { clockOffset = 0 } = {}) {
        ctx.calls.push += 1
        ctx.log.push({ op: 'push', collection, count: (docs || []).length, openid })
        await tick()
        maybeFail()

        // 与真云端同语义：把本地时间戳校正到服务端时间轴后再比（S4-2），
        // 并且**优先比服务端刻度**（S4-6）。两者都必须与 core/merge.js 的
        // shouldTakeRemote 一致，否则推送与拉取会给出相反答案、两端来回打架。
        const offset = Number.isFinite(clockOffset) ? clockOffset : 0
        const upserted = []
        const rejected = []
        /**
         * 本次成功写入的文档被盖上的刻度：`{ [本地id]: 服务端刻度 }`。
         *
         * 为什么要回给调用方（S4-6 收敛的关键一环）：
         *   服务端盖的刻度**只有服务端知道**，写者的本地副本不会自动获得它。
         *   写者下次拉取时手里那份「没刻度」，与远端「有刻度」的比不了，
         *   只能退回客户端 `updatedAt` 比较 —— 时钟偏差下又回到不收敛。
         *   所以推送成功后必须**把刻度写回本地副本**，本地副本才算真的「是这一版」。
         *   这与真云端「云函数盖完刻度、下次 pull 自然带回来」等价，只是省了一轮。
         */
        const stamps = {}
        for (const doc of docs || []) {
          const id = doc._id || doc.id
          if (!id) continue
          const key = keyOf(openid, collection, id)
          const prev = rows.get(key)

          /**
           * 条件 upsert：云端这份更新就不覆盖，并把决定权交回客户端。
           *
           * ⚠️ **参数顺序是 `(本地, 远端)`，即 `(doc, prev)`** —— 与 pull 侧
           *    `partitionRemote` 的 `shouldTakeRemote(localDoc, remoteDoc)` 同向。
           *    语义是「**该不该采纳远端那份**」：对推送来说，「远端」就是云端已有的
           *    `prev`，所以：
           *
           *      shouldTakeRemote(doc, prev) === true  ⇒ 云端那份更新 ⇒ 拒绝本次推送
           *      shouldTakeRemote(doc, prev) === false ⇒ 本地这份不旧 ⇒ 允许覆盖
           *
           *    早先写成 `shouldTakeRemote(prev, doc)`（参数反了）会**恰好判反**：
           *    慢时钟设备明明带着更新的内容，却被自己的「更旧客户端时间戳」挡住，
           *    推送被拒 + 拉回的旧版本又覆盖不回（合并侧判的是 keep）—— 这才是
           *    第 3 组 3d/3e 失败的真正原因。**不要改回去。**
           */
          if (prev && shouldTakeRemote(doc, prev, offset)) {
            rejected.push({ id, cloudUpdatedAt: Number(prev.serverUpdatedAt) || prev.updatedAt || 0 })
            continue
          }

          const { _openid, ...clean } = doc
          void _openid
          rows.set(key, {
            ...clean,
            _id: id,
            _openid: openid, // 云端注入的归属字段，客户端不该自己写
            /**
             * 服务端接收时间 —— **水位线只认它，不认客户端的 updatedAt**。
             *
             * 为什么：设备 B 在 T5 记了一笔但没联网，设备 A 在 T6 同步
             * （T6 > T5），B 到 T7 才推上去。如果按 updatedAt 过滤，A 下次
             * pull(since=T6) 会永远漏掉这笔 T5 的账。按服务端接收时间过滤，
             * 它在 T7 被写入、标记为 T7，A 下一次就拉到了。
             */
            _serverTs: serverNow(),
            /**
             * ⚠️ 存的必须是**客户端原始** `updatedAt`，不是校正后的 `localTs`。
             *
             * `clockOffset` 只在「比较的那一刻」用一次，**绝不能落盘**。
             * 存校正值等于把当前的偏移量固化进数据：
             *   - 偏移会随网络往返抖动，每次同步算出来都不完全一样；
             *   - 固化后会把「慢时钟设备」的偏移叠加到云端值上，
             *     下一轮再算偏移又是一次叠加，误差**逐轮累积**；
             *   - 真云端 `cloudbaseAdapter.push` 写的就是原始 `doc`（只剥元数据、
             *     不动 `updatedAt`），假云端必须一致，否则测试会验出一个
             *     现实中不存在的行为。
             *
             * 客户端时间戳是**冲突裁决的依据**，保持原样由合并层按需校正。
             */
            updatedAt: clean.updatedAt,
            /**
             * 服务端裁决刻度（S4-6）—— **与真云端同语义**。
             *
             * 真云端是在 `.set()` 之后调 `ledger-sync-stamp` 云函数补上这个字段；
             * 假云端在同一个 push 里直接写，效果等价（都是「服务端接收这一刻」）。
             *
             * 它的唯一用途是**跨设备裁决**：`shouldTakeRemote` 优先比它，
             * 这样两台设备不再因为各自的本地时钟偏差而互相认为「我更新」。
             * `_noServerStamp(true)` 可关掉，用来验证降级路径。
             */
            ...(ctx.noServerStamp ? {} : { serverUpdatedAt: serverNow() })
          })
          // 把刚盖上的刻度也回给调用方，好让它写回本地副本（见上方 stamps 注释）
          const stamped = rows.get(key).serverUpdatedAt
          if (stamped) stamps[id] = stamped
          upserted.push(id)
        }
        return { upserted, rejected, stamps }
      },

      async pull(collection, { since = 0, cursor = null, limit = pageSize, ids = null } = {}) {
        ctx.calls.pull += 1
        // 在查询**开始前**取服务端时间，作为本次快照的水位。
        // 查询期间产生的新写入（_serverTs 会大于它）留给下一次拉取，
        // 否则这些更新会被永久跳过。
        const snapshotAt = serverNow()
        await tick()
        maybeFail()

        let matched = [...rows.entries()]
          .filter(([key]) => key.startsWith(prefixOf(openid, collection)))
          .map(([, doc]) => doc)

        if (Array.isArray(ids) && ids.length) {
          const set = new Set(ids)
          matched = matched.filter((d) => set.has(d._id))
        } else {
          /**
           * 区间是 `[since, snapshotAt]`，**左闭右闭** —— 与真云端同语义。
           *
           * ⚠️ 左端**必须闭**（`>=` 而不是 `>`）。这一点很容易想反：
           * 「上次已经拉到 `since` 了，这次不必再拉」听起来天经地义，但水位线
           * 记的是**快照时刻**，不是「已拉到的最新文档时间」。两者相等时会出现
           * 这样的交错：
           *
           *   ① 本轮 pull 取快照 `snapshotAt = T`，水位线落成 T；
           *   ② 同一轮里紧接着 push，服务端接收时间也被盖成 T（同一毫秒）；
           *   ③ 下一轮 `since = T`，而那条文档的 `_serverTs` 正是 T。
           *
           * 左开就会把 `T > T` 判为假、永远拉不到它 —— **数据永久丢失**。
           * 左闭最多重复拉一次，而重复拉是无副作用的（合并规则会按 updatedAt
           * 裁决，同一份文档重复到达结果相同）。**宁可重复，不能漏。**
           *
           * 右端闭合（`<= snapshotAt`）则是为了「恰好在快照时刻写入的那条」
           * 必须包含进来，否则同样会漏。
           *
           * 真云端 cloudbaseAdapter 用的就是 `_.gte(...)`（左闭），这里是刻意对齐。
           */
          matched = matched.filter((d) => {
            const ts = d._serverTs || 0
            return ts >= since && ts <= snapshotAt
          })
        }

        // 顺序必须显式指定：Map 的迭代序是插入序，不是契约
        matched.sort(
          (a, b) =>
            (a._serverTs || 0) - (b._serverTs || 0) || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0)
        )

        const start = Number(cursor) || 0
        const page = matched.slice(start, start + limit)
        ctx.log.push({ op: 'pull', collection, got: page.length, total: matched.length, openid })

        return {
          docs: page.map((d) => ({ ...d })),
          serverTime: snapshotAt,
          hasMore: start + page.length < matched.length,
          cursor: start + page.length
        }
      },

      async serverTime() {
        ctx.calls.serverTime += 1
        await tick()
        maybeFail()
        // 契约（见 cloudClient.js）：返回 { value, source } 而不是裸数字。
        // fakeCloud 的时间就是「测试时钟」，等价于真云端的云函数返回值，
        // 所以 source 标 'cloud-function'（可信、可裁决）。
        // 需要模拟「云函数不可用、降级到下界」时，用 opts.serverTimeSource 覆盖。
        return {
          value: serverNow(),
          source: ctx.serverTimeSource || 'cloud-function'
        }
      }
    }
  }

  const defaultUser = 'user_default'

  return {
    ...clientFor(defaultUser),

    /**
     * 取一个绑定指定身份的客户端（同一后端）。
     * 用它模拟「换账号」或「同一账号的另一台设备」。
     */
    as(openid) {
      return clientFor(openid || defaultUser)
    },

    /* ---------------- 以下只给测试用，真云端没有 ---------------- */

    /** 偷看云端内容（绕过权限，仅供断言） */
    _dump(collection, who = defaultUser) {
      return [...rows.entries()]
        .filter(([key]) => key.startsWith(prefixOf(who, collection)))
        .map(([, doc]) => ({ ...doc }))
        .sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))
    },

    /** 接下来 n 次 push / pull 抛错（模拟断网、服务端 5xx） */
    _failNext(n, error = null) {
      ctx.failures = n
      ctx.failure = error
      return n
    },

    /**
     * 进入「持续失败」模式：之后每次调用都抛错，不会自愈。
     * 用来验证**不可重试类别**的处置（登录失效 / 配额用完 / 权限被拒）——
     * 这些光靠退避重试永远好不了，引擎必须停下来而不是一直打。
     *
     * 传 `{ kind: 'auth-expired' }` 会抛一个带 kind 标记的错误。
     * 传 `null` 恢复正常。
     */
    _failAlways(error = null) {
      ctx.persistentFailure = error
      return error
    },

    /** 服务端时间偏移。只为把「时钟不可信」暴露出来，S2 不对它做断言 */
    _skew(ms) {
      ctx.skew = Number(ms) || 0
      return ctx.skew
    },

    /**
     * 把 serverTime() 的 source 改成 'watermark-lower-bound'，
     * 模拟「云函数不可用 → 降级取水位线下界」。
     * 不传参数则恢复 'cloud-function'。
     */
    _serverTimeSource(src = 'cloud-function') {
      ctx.serverTimeSource = src
      return ctx.serverTimeSource
    },

    /**
     * 关掉「服务端裁决刻度」（S4-6）：之后 push 写入的文档**不带**
     * `serverUpdatedAt`，等价于真云端**云函数不可用**时的情况。
     *
     * 用它验证降级路径：没有刻度时裁决必须退回 S4-2 的「客户端时间戳 + 单侧校正」，
     * 而不是报错或卡住 —— 刻度是增强，不是必需品。
     */
    _noServerStamp(on = true) {
      ctx.noServerStamp = Boolean(on)
      return ctx.noServerStamp
    },

    /** 调用计数（验证防重入 / 防抖：并发 5 次只该发 1 轮） */
    _calls() {
      return { ...ctx.calls }
    },

    _log() {
      return ctx.log.map((x) => ({ ...x }))
    },

    _size(collection = null, who = defaultUser) {
      if (!collection) return rows.size
      return this._dump(collection, who).length
    },

    _reset() {
      rows.clear()
      ctx.failures = 0
      ctx.failure = null
      ctx.persistentFailure = null
      ctx.skew = 0
      ctx.serverTimeSource = 'cloud-function'
      ctx.noServerStamp = false
      ctx.calls = { push: 0, pull: 0, serverTime: 0 }
      ctx.log = []
      return true
    }
  }
}
