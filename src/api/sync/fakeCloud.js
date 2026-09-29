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
 * 隔离是怎么实现的：push 时给文档打上当前身份的 `_openid`，pull 时只返回
 * `_openid` 匹配的文档。**注意这只是「客户端自觉」** —— 真实的隔离靠服务端
 * 安全规则，假云端证明不了那件事（见 phase2-backend-plan.md 的 S3 验收）。
 */

export function createFakeCloud({ latency = 0, pageSize = 100, clock = () => Date.now() } = {}) {
  /** key = `${openid}\0${collection}\0${_id}`，一个后端被所有身份共用 */
  const rows = new Map()
  const ctx = {
    failures: 0,
    failure: null,
    skew: 0,
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
  }

  /**
   * 服务端时钟：**严格单调递增**。
   * 真实的服务端时间也只会前进；这里额外保证「同一毫秒内的多次写入一定拿到
   * 不同的时间戳」，否则水位线会把同一毫秒里的更新判成「已经拉过了」而漏掉。
   */
  let serverClock = 0
  const serverNow = () => {
    const base = clock() + ctx.skew
    serverClock = base > serverClock ? base : serverClock + 1
    return serverClock
  }

  function clientFor(openid) {
    return {
      openid,

      async push(collection, docs) {
        ctx.calls.push += 1
        ctx.log.push({ op: 'push', collection, count: (docs || []).length, openid })
        await tick()
        maybeFail()

        const upserted = []
        const rejected = []
        for (const doc of docs || []) {
          const id = doc._id || doc.id
          if (!id) continue
          const key = keyOf(openid, collection, id)
          const prev = rows.get(key)
          const localTs = doc.updatedAt || 0
          const remoteTs = prev ? prev.updatedAt || 0 : -1

          // 条件 upsert：本地这份更旧就不覆盖，并把决定权交回客户端
          if (prev && localTs < remoteTs) {
            rejected.push({ id, cloudUpdatedAt: remoteTs })
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
            updatedAt: localTs // 保留客户端时间戳：它是**冲突裁决**的依据，不是水位依据
          })
          upserted.push(id)
        }
        return { upserted, rejected }
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
          // 区间是 (since, snapshotAt]，**右端闭合**：
          //   左开 —— 上次已经拉过的不要重复拉
          //   右闭 —— 恰好在快照时刻写入的那条必须包含进来，否则会永久漏掉
          matched = matched.filter((d) => {
            const ts = d._serverTs || 0
            return ts > since && ts <= snapshotAt
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
        return serverNow()
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

    /** 服务端时间偏移。只为把「时钟不可信」暴露出来，S2 不对它做断言 */
    _skew(ms) {
      ctx.skew = Number(ms) || 0
      return ctx.skew
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
      ctx.skew = 0
      ctx.calls = { push: 0, pull: 0, serverTime: 0 }
      ctx.log = []
      return true
    }
  }
}
