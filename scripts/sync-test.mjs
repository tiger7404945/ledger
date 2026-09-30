/**
 * 同步引擎验收（第二阶段 S2）
 * 运行：npm run test:data（或单独 node scripts/sync-test.mjs）
 *
 * 脚本刻意分成两层，因为「调度」与「接线」的失败原因完全不同：
 *
 *   A) 调度层 —— 用「内存设备」验证 syncEngine 的行为（快、无噪声）。
 *      一台设备 = 独立的内存队列 + 独立的本地表 + 一个引擎；
 *      两台设备共用一个 fakeCloud，就构成「同一账号的两台机器」。
 *
 *   B) 接线层 —— 用真实的 idbAdapter + fake-indexeddb 验证端到端：
 *      适配器写 → outbox → 引擎 → 云端 → 换设备拉回。
 *
 * ⚠️ 时间是**注入**的：所有用例共用一个测试时钟，fakeCloud 的 serverTime
 *    与文档的 updatedAt 同源。否则水位线（serverTime）会跑到文档时间前面去，
 *    增量拉取永远拉不到东西 —— 这种假失败最容易被误判成真 bug。
 *
 * ⚠️ 定时器也是注入的（createFakeTimer）。否则「失败后 2 秒重试」会让
 *    整个脚本多跑好几秒，而且退避延迟没法被断言。
 */

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
}
globalThis.window = globalThis

const ROOT = new URL('../', import.meta.url).href
const SRC = `${ROOT}src/`

await import(`${ROOT}node_modules/fake-indexeddb/auto/index.mjs`)

const { createSyncEngine, backoffDelay } = await import(`${SRC}api/sync/syncEngine.js`)
const { createFakeCloud } = await import(`${SRC}api/sync/fakeCloud.js`)
const { createOutbox } = await import(`${SRC}api/sync/outbox.js`)
const { createMemoryOutboxStore, createIdbOutboxStore } = await import(
  `${SRC}api/sync/outboxStore.js`
)
const { partitionRemote } = await import(`${SRC}api/core/merge.js`)
const { createIdbAdapter } = await import(`${SRC}api/adapters/idbAdapter.js`)

/* ---------------------------------------------------------- */
/* 断言与工具                                                   */
/* ---------------------------------------------------------- */

let pass = 0
let fail = 0

function eq(label, got, want) {
  const good = JSON.stringify(got) === JSON.stringify(want)
  if (good) pass += 1
  else fail += 1
  console.log(
    `${good ? '✓' : '✗'} ${label}${good ? '' : `\n    期望 ${JSON.stringify(want)}\n    实得 ${JSON.stringify(got)}`}`
  )
}

function ok(label, cond, extra = '') {
  if (cond) pass += 1
  else fail += 1
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : `  ${extra}`}`)
}

function group(title) {
  console.log(`\n== ${title} ==`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 测试时钟：serverTime 与文档 updatedAt 同源，水位线才能自洽 */
function createClock(start = 1_700_000_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms = 1000) => (t += ms),
    stamp: () => (t += 1000)
  }
}

/** 可控定时器：既能断言退避延迟，又不用真的等 2 秒 */
function createFakeTimer() {
  const tasks = []
  let seq = 0
  const self = {
    setTimeout(fn, ms) {
      const id = ++seq
      tasks.push({ id, fn, ms, fired: false, cancelled: false })
      return id
    },
    clearTimeout(id) {
      const task = tasks.find((x) => x.id === id)
      if (task) task.cancelled = true
    },
    pending() {
      return tasks.filter((x) => !x.cancelled && !x.fired)
    },
    delays() {
      return self.pending().map((x) => x.ms)
    },
    async flush() {
      const due = self.pending()
      due.forEach((x) => {
        x.fired = true
      })
      for (const task of due) await task.fn()
    }
  }
  return self
}

const billDoc = (clock, id, amount, extra = {}) => ({
  id,
  ledgerId: 'ledger_default',
  type: 'expense',
  amount,
  categoryId: null,
  primaryCategoryId: null,
  remark: '',
  date: '2026-09-29',
  noReimburse: false,
  createdAt: clock.now(),
  updatedAt: clock.stamp(),
  deleted: 0,
  version: 1,
  ...extra
})

/**
 * 造一台「内存设备」：独立的队列 + 独立的本地表 + 一个引擎。
 * 两台设备共用同一个 fakeCloud，就是「同一账号的两台机器」。
 *
 * ⚠️ `now` 必须把测试时钟注进去。S4-2 之后引擎会用 `now()` 去算
 * "本地时钟相对服务端的偏差"（`服务端时间 - 本地时间`）。如果引擎用的是真实
 * `Date.now()` 而 fakeCloud 用的是测试时钟（1.7e12），算出来的 offset 会是
 * 一个 -9e10 量级的巨大数字，把所有时间戳比较全部掀翻 —— 表现为一片假失败。
 * 测试时钟与 fakeCloud 同源，所以正确注入后 offset 天然是 0，
 * 「新者胜」的裁决就回到纯粹的 updatedAt 比较上。
 */
async function makeDevice({ cloud, user = null, debounceMs, timer, isOnline, now } = {}) {
  const outbox = createOutbox(createMemoryOutboxStore())
  const tables = new Map()
  const table = (c) => {
    if (!tables.has(c)) tables.set(c, new Map())
    return tables.get(c)
  }

  let watermark = 0
  const meta = {
    async get() {
      return watermark
    },
    async set(key, value) {
      watermark = value
      return true
    }
  }

  const store = {
    async get(collection, id) {
      return table(collection).get(id) || null
    },
    async applyRemote(collection, docs, clockOffset = 0) {
      const locals = [...table(collection).values()]
      // 与适配器共用同一条合并规则（core/merge.js）
      const { take, keep } = partitionRemote(locals, docs, clockOffset)
      take.forEach((d) => table(collection).set(d.id, d))
      return { applied: take.length, kept: keep.length }
    }
  }

  const engine = createSyncEngine({
    outbox,
    store,
    meta,
    cloud: user ? cloud.as(user) : cloud,
    ...(now ? { now } : {}),
    ...(debounceMs !== undefined ? { debounceMs } : {}),
    ...(timer ? { timer } : {}),
    ...(isOnline ? { isOnline } : {})
  })

  return {
    outbox,
    engine,
    store,
    async write(collection, doc) {
      table(collection).set(doc.id, { ...doc })
      await outbox.enqueue({ collection, op: 'update', docId: doc.id, payload: { ...doc } })
      return doc
    },
    async softDelete(collection, id, ts) {
      const next = { ...table(collection).get(id), deleted: 1, updatedAt: ts }
      table(collection).set(id, next)
      await outbox.enqueue({ collection, op: 'delete', docId: id, payload: next })
      return next
    },
    get(collection, id) {
      return table(collection).get(id) || null
    },
    all(collection) {
      return [...table(collection).values()]
    },
    watermark: () => watermark
  }
}

const snapshotOf = (doc) => {
  if (!doc) return null
  const { _id, _openid, ...rest } = doc
  void _id
  void _openid
  return rest
}

/* ========================================================== */
/* 1. 基本往返                                                  */
/* ========================================================== */

group('1. 基本往返：本地写 3 条 → push → 清空本地 → pull → 完整回来')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const a = await makeDevice({ cloud, now: clock.now })

  await a.write('bill', billDoc(clock, 'r1', 100))
  await a.write('bill', billDoc(clock, 'r2', 200))
  await a.write('bill', billDoc(clock, 'r3', 300))

  const first = await a.engine.sync({ manual: true })
  ok('1a 同步成功', first.ok === true, JSON.stringify(first))
  eq('1b 三条都推上了云端', cloud._dump('bill').length, 3)
  eq('1c 队列已清空', await a.outbox.pendingCount(), 0)

  // 换一台设备（本地是空的，水位也是 0）
  const b = await makeDevice({ cloud, now: clock.now })
  eq('1d 新设备本地为空', b.all('bill').length, 0)

  const second = await b.engine.sync({ manual: true })
  ok('1e 新设备同步成功', second.ok === true)
  eq('1f 三条完整回来', b.all('bill').map((d) => d.id).sort(), ['r1', 'r2', 'r3'])
  eq('1g 金额逐条对上', b.all('bill').map((d) => d.amount).sort((x, y) => x - y), [100, 200, 300])
  eq('1h 不带云端的 _id / _openid 落本地', snapshotOf(b.get('bill', 'r1'))._openid, undefined)
}

/* ========================================================== */
/* 2. 幂等                                                     */
/* ========================================================== */

group('2. 幂等：重复推送不产生重复文档')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })

  await cloud.push('bill', [billDoc(clock, 'i1', 10)])
  await cloud.push('bill', [billDoc(clock, 'i1', 10)])
  await cloud.push('bill', [billDoc(clock, 'i1', 10)])
  eq('2a 同一 id 推三次云端只有一条', cloud._dump('bill').filter((d) => d._id === 'i1').length, 1)

  // 经由引擎：同一笔账改两次，只会 upsert 不会产生第二条
  const a = await makeDevice({ cloud, now: clock.now })
  await a.write('bill', billDoc(clock, 'i2', 50))
  await a.engine.sync({ manual: true })
  await a.write('bill', billDoc(clock, 'i2', 60))
  await a.engine.sync({ manual: true })
  eq('2b 改两次仍是同一条', cloud._dump('bill').filter((d) => d._id === 'i2').length, 1)
  eq('2c 云端已是新值', cloud._dump('bill').find((d) => d._id === 'i2').amount, 60)
}

/* ========================================================== */
/* 3. 离线补推                                                 */
/* ========================================================== */

group('3. 离线补推：写 5 条 → 恢复网络 → 一次同步全部补推')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const timer = createFakeTimer()
  const a = await makeDevice({ cloud, timer, now: clock.now })

  cloud._failNext(10) // 这段时间内所有云端调用都失败
  for (let i = 0; i < 5; i += 1) await a.write('bill', billDoc(clock, `off${i}`, 10 + i))

  const failed = await a.engine.sync({ manual: true })
  eq('3a 同步失败', failed.ok, false)
  eq('3b 状态进入 error', a.engine.state, 'error')
  ok('3c lastError 有内容', !!a.engine.lastError?.message)
  eq('3d 5 条都还在队列里', await a.outbox.pendingCount(), 5)
  eq('3e 本地数据一条没丢', a.all('bill').length, 5)
  eq('3f 云端此时还是空的', cloud._dump('bill').length, 0)

  cloud._failNext(0) // 恢复网络
  const recovered = await a.engine.sync({ manual: true })
  eq('3g 恢复后一次同步成功', recovered.ok, true)
  eq('3h 云端 5 条', cloud._dump('bill').length, 5)
  eq('3i 队列清空', await a.outbox.pendingCount(), 0)
  eq('3j 全部标记已同步', cloud._dump('bill').filter((d) => d.updatedAt > 0).length, 5)
}

/* ========================================================== */
/* 4. 重试与状态回调                                            */
/* ========================================================== */

group('4. 重试与状态回调：retry 递增、回调拿到 error、退避延迟正确')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const timer = createFakeTimer()
  const a = await makeDevice({ cloud, timer, now: clock.now })

  const seen = []
  const off = a.engine.onStateChange((s) => seen.push(s.state))
  ok('4a 订阅时立刻回调一次当前状态', seen.length >= 1)

  await a.write('bill', billDoc(clock, 'rt1', 10))
  cloud._failNext(10)
  const r1 = await a.engine.sync({ manual: true })

  eq('4b 回调里出现过 syncing', seen.includes('syncing'), true)
  eq('4c 回调里出现过 error', seen.includes('error'), true)
  eq('4d 失败返回 retry=1', r1.retry, 1)
  eq('4e 待推条目的 retry 递增到 1', (await a.outbox.pending())[0].retry, 1)
  ok('4f 失败后按 2 秒退避安排了重试', timer.delays().includes(2000), JSON.stringify(timer.delays()))

  const r2 = await a.engine.sync({ manual: true })
  eq('4g 再失败一次 retry=2', r2.retry, 2)
  eq('4h 条目的 retry 到 2', (await a.outbox.pending())[0].retry, 2)
  ok('4i 第二次退避是 4 秒', timer.delays().includes(4000), JSON.stringify(timer.delays()))

  eq(
    '4j 退避表 2/4/8/16/32 秒',
    [1, 2, 3, 4, 5].map((n) => backoffDelay(n)),
    [2000, 4000, 8000, 16000, 32000]
  )
  eq('4k 超过上限不再自动重试', backoffDelay(6), null)

  cloud._failNext(0)
  const r3 = await a.engine.sync({ manual: true })
  eq('4l 成功后退避计数归零', a.engine.retry, 0)
  eq('4m 状态回到 idle', a.engine.state, 'idle')
  ok('4n 落下了水位线', a.watermark() > 0)
  off()
}

/* ========================================================== */
/* 5. 防重入                                                   */
/* ========================================================== */

group('5. 防重入：并发 5 次 sync 只发一轮请求')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const a = await makeDevice({ cloud, now: clock.now })

  await a.write('bill', billDoc(clock, 'g1', 10))
  const before = cloud._calls()

  const p1 = a.engine.sync()
  const p2 = a.engine.sync()
  ok('5a 第二次调用拿到的是同一个 in-flight Promise', p1 === p2)

  const rest = await Promise.all([p1, p2, a.engine.sync(), a.engine.sync(), a.engine.sync()])
  const after = cloud._calls()

  eq('5b 只发了一轮 push', after.push - before.push, 1)
  eq('5c 只发了一轮 pull（每集合一次，共 3 次）', after.pull - before.pull, 3)
  ok(
    '5d 五个 Promise 结果一致',
    rest.every((r) => r.ok === rest[0].ok && r.pushed === rest[0].pushed)
  )
  eq('5e 一轮就推完了', cloud._dump('bill').length, 1)
}

/* ========================================================== */
/* 6. 写后防抖                                                 */
/* ========================================================== */

group('6. 写后防抖：连写 3 次只触发 1 轮同步')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const timer = createFakeTimer()
  const a = await makeDevice({ cloud, debounceMs: 2000, timer, now: clock.now })

  a.engine.start()
  await a.engine.sync() // 复用 startup 那一轮，确保基准稳定
  await sleep(0)
  const beforePush = cloud._calls().push

  await a.write('bill', billDoc(clock, 'd1', 1))
  await a.write('bill', billDoc(clock, 'd2', 2))
  await a.write('bill', billDoc(clock, 'd3', 3))

  eq('6a 三次写入只留一个防抖任务', timer.pending().filter((t) => t.ms === 2000).length, 1)

  await timer.flush()
  await sleep(0)

  eq('6b 只触发了一轮 push', cloud._calls().push - beforePush, 1)
  eq('6c 三条都推上去了', cloud._dump('bill').length, 3)
  a.engine.stop()
  eq('6d stop 之后监听已摘掉', a.engine.stop(), true)
}

/* ========================================================== */
/* 7. 新者胜                                                   */
/* ========================================================== */

group('7. 新者胜：云端更新时本地取云端版本')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const a = await makeDevice({ cloud, now: clock.now })

  // 云端先有一条较新的
  await cloud.push('bill', [billDoc(clock, 'w1', 15)])
  const cloudTs = cloud._dump('bill')[0].updatedAt

  // 本地拿一份更旧的（时钟倒退 5 秒）
  await a.write('bill', billDoc(clock, 'w1', 20, { updatedAt: clock.now() - 5000 }))

  const r = await a.engine.sync({ manual: true })
  eq('7a 同步成功', r.ok, true)
  eq('7b 本地取到云端的较新版本', a.get('bill', 'w1').amount, 15)
  eq('7c 云端没被旧版本冲掉', cloud._dump('bill')[0].amount, 15)
  eq('7d 云端时间戳未变', cloud._dump('bill')[0].updatedAt, cloudTs)
  eq('7e 队列已清空（没有反复重推）', await a.outbox.pendingCount(), 0)
}

/* ========================================================== */
/* 8. 陈旧推送被拒                                             */
/* ========================================================== */

group('8. 陈旧推送被拒：条件 upsert 把决定权交回客户端')
{
  const cloud = createFakeCloud()

  await cloud.push('bill', [{ id: 's1', updatedAt: 2000, amount: 2 }])
  const rejectedRes = await cloud.push('bill', [{ id: 's1', updatedAt: 1000, amount: 1 }])

  eq('8a 较旧的推送被拒绝', rejectedRes.rejected.length, 1)
  eq('8b rejected 带回云端的时间戳', rejectedRes.rejected[0].cloudUpdatedAt, 2000)
  eq('8c 没有写入任何一条', rejectedRes.upserted.length, 0)
  eq('8d 云端保住较新版本', cloud._dump('bill')[0].amount, 2)

  const sameRes = await cloud.push('bill', [{ id: 's1', updatedAt: 2000, amount: 3 }])
  eq('8e 时间戳相同则允许覆盖', sameRes.upserted.length, 1)
  eq('8f 云端已更新', cloud._dump('bill')[0].amount, 3)
}

/* ========================================================== */
/* 9. 软删除                                                   */
/* ========================================================== */

group('9. 软删除：删除标记跨设备传播，且不复活')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const a = await makeDevice({ cloud, now: clock.now })
  const b = await makeDevice({ cloud, now: clock.now })

  await a.write('bill', billDoc(clock, 'dl1', 50))
  await a.engine.sync({ manual: true })
  await b.engine.sync({ manual: true })
  eq('9a 设备 b 拉到了这条', b.get('bill', 'dl1').deleted, 0)

  await b.softDelete('bill', 'dl1', clock.stamp())
  const rb = await b.engine.sync({ manual: true })
  eq('9b b 推送成功', rb.ok, true)

  await a.engine.sync({ manual: true })
  eq('9c 删除态传播到 a', a.get('bill', 'dl1').deleted, 1)
  eq('9d a 这边没有把它「复活」', a.all('bill').length, 1)

  await a.engine.sync({ manual: true })
  eq('9e 再同步一次仍是删除态', a.get('bill', 'dl1').deleted, 1)
  eq('9f 云端也是删除态', cloud._dump('bill')[0].deleted, 1)
}

/* ========================================================== */
/* 10. 水位增量                                                */
/* ========================================================== */

group('10. 水位增量：第二次 pull 只拿水位附近的增量，不重不漏')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })

  await cloud.push('bill', [billDoc(clock, 'y1', 1), billDoc(clock, 'y2', 2)])
  const all = await cloud.pull('bill', { since: 0 })
  eq('10a 首次按 since=0 拿到全量', all.docs.length, 2)
  eq('10b 首次没有更多页', all.hasMore, false)

  // 水位用**云端给的快照时间**，不是本地时钟
  const watermark = all.serverTime

  // ⚠️ 区间是左闭的（与真云端 `_.gte` 一致），所以「用同一个水位再拉一次」
  //    会**重复**拿到快照时刻那批文档 —— 这是刻意的：
  //    快照时刻与「本轮 push 的服务端接收时间」可能落在同一毫秒，
  //    左开会把 `T > T` 判假而永久漏掉它（实测就是 13c 收敛失败那个 bug）。
  //    重复拉无副作用：合并规则按 updatedAt 裁决，同一份文档重复到达结果相同。
  //    所以这里断言的是「不丢」与「幂等」，不是「一条都不重复」。
  const again = await cloud.pull('bill', { since: watermark })
  eq('10c 同水位重拉不丢数据（左闭，可能重复但不漏）', again.docs.length, 2)
  eq('10c2 重拉到的就是原来那两条', again.docs.map((d) => d._id).sort(), ['y1', 'y2'])

  await cloud.push('bill', [billDoc(clock, 'y3', 3)])
  const inc = await cloud.pull('bill', { since: watermark })
  eq('10d 新推的那条出现在增量里', inc.docs.map((d) => d._id).includes('y3'), true)

  // 关键回归：**推送晚、但本地时间戳更早**的变更也必须能被拉到。
  // 这正是「水位不能按 updatedAt 过滤」的原因 —— 按客户端时间过滤会永久漏掉它。
  clock.advance(-4000)
  await cloud.push('bill', [billDoc(clock, 'y4', 4)])
  const late = await cloud.pull('bill', { since: watermark })
  eq('10e 时间戳更早但推送更晚的也能拉到', late.docs.map((d) => d._id).includes('y4'), true)

  // 引擎级：水位持久化后，第二轮同步不会重复拉全量
  const a = await makeDevice({ cloud, now: clock.now })
  await a.engine.sync({ manual: true })
  eq('10f 引擎按水位拉到全部 4 条', a.all('bill').length, 4)
  const before = cloud._calls().pull
  await a.engine.sync({ manual: true })
  eq('10g 第二轮仍会查询（但拿不到新数据）', cloud._calls().pull > before, true)
  eq('10h 本地条数没有翻倍（重复到达不会变成两条）', a.all('bill').length, 4)
  eq('10i 水位已推进', a.watermark() > 0, true)
}

/* ========================================================== */
/* 11. 队列搬迁                                                */
/* ========================================================== */

group('11. 队列搬迁：旧 localStorage 队列导入 IndexedDB，只导一次、不删旧键')
{
  const legacy = [
    {
      id: 'ob_legacy_1',
      collection: 'bill',
      op: 'create',
      docId: 'legacy1',
      payload: { id: 'legacy1' },
      ts: 1,
      retry: 0,
      synced: false
    }
  ]
  localStorage.setItem('ledger.outbox.v1', JSON.stringify(legacy))

  const dbName = 'ledger_outbox_migrate'
  const ob1 = createOutbox(createIdbOutboxStore({ dbName }))
  const rows1 = await ob1.all()
  eq('11a 旧队列进了 IndexedDB', rows1.length, 1)
  eq('11b 内容原样带过来', rows1[0].docId, 'legacy1')
  ok('11c 旧 localStorage 键仍在（可回退）', localStorage.getItem('ledger.outbox.v1') !== null)

  // 新建一个实例（相当于重新打开应用）：标记生效，不该重复导入
  const ob2 = createOutbox(createIdbOutboxStore({ dbName }))
  const rows2 = await ob2.all()
  eq('11d 幂等：不会导入第二遍', rows2.length, 1)

  await ob2.clear()
  const ob3 = createOutbox(createIdbOutboxStore({ dbName }))
  eq('11e 清空后不会因为旧键还在而复活', (await ob3.all()).length, 0)
  localStorage.removeItem('ledger.outbox.v1')
}

/* ========================================================== */
/* 12. 队列压缩                                                */
/* ========================================================== */

group('12. 队列压缩：同步完不残留已同步条目')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const a = await makeDevice({ cloud, now: clock.now })

  await a.write('bill', billDoc(clock, 'k1', 1))
  await a.write('bill', billDoc(clock, 'k2', 2))
  eq('12a 入队后队列有 2 条', await a.outbox.pendingCount(), 2)

  await a.engine.sync({ manual: true })
  eq('12b 待推归零', await a.outbox.pendingCount(), 0)
  eq('12c 队列里不残留已同步条目（否则会无限长下去）', (await a.outbox.all()).length, 0)
  eq('12d 数据仍在本地', a.all('bill').length, 2)
}

/* ========================================================== */
/* 13. 双实例收敛                                              */
/* ========================================================== */

group('13. 双实例收敛：两台设备同改一条，最终收敛到同一版本')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const a = await makeDevice({ cloud, now: clock.now })
  const b = await makeDevice({ cloud, now: clock.now })

  await a.write('bill', billDoc(clock, 'm1', 10))
  await a.engine.sync({ manual: true })
  await b.engine.sync({ manual: true })
  eq('13a 两台设备起点一致', [a.get('bill', 'm1').amount, b.get('bill', 'm1').amount], [10, 10])

  // 两边各改一次（都没先同步）—— b 的时间戳更晚
  await a.write('bill', billDoc(clock, 'm1', 20))
  await b.write('bill', billDoc(clock, 'm1', 30))

  await a.engine.sync({ manual: true })
  await b.engine.sync({ manual: true })
  await a.engine.sync({ manual: true })
  await b.engine.sync({ manual: true })

  eq(
    '13b 两端本地状态深度相等',
    snapshotOf(a.get('bill', 'm1')),
    snapshotOf(b.get('bill', 'm1'))
  )
  eq('13c 收敛到 updatedAt 较新的一版', a.get('bill', 'm1').amount, 30)
  eq('13d 云端与两端一致', cloud._dump('bill')[0].amount, 30)
  eq('13e 两边的队列都空了', [await a.outbox.pendingCount(), await b.outbox.pendingCount()], [0, 0])
  eq('13f 云端只有一条（没有裂成两条）', cloud._dump('bill').length, 1)
}

/* ========================================================== */
/* 14. 拒绝后回拉（引擎级）                                     */
/* ========================================================== */

group('14. 拒绝后回拉：本地时钟倒退时，必须收敛到云端版本')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const a = await makeDevice({ cloud, now: clock.now })

  await a.write('bill', billDoc(clock, 'c1', 10))
  await a.engine.sync({ manual: true })
  // 再写一条**别的**账单并同步，把水位推到这条之后：
  // 此后 c1 不会再被 pull 拉到（它的 _serverTs 已经小于水位），
  // push 成了唯一的信息来源 —— 这正是「推送被拒」最危险的场景。
  // ⚠️ 不能只靠「多同步一轮」来推水位：区间是左闭的，
  //    再同步一轮水位仍等于 c1 的 _serverTs，照样能拉到它。
  await a.write('bill', billDoc(clock, 'c2', 7))
  await a.engine.sync({ manual: true })
  const watermark = a.watermark()
  eq('14a 首次同步完成', cloud._dump('bill').find((d) => d._id === 'c1').amount, 10)
  ok(
    '14a1 水位已越过 c1（push 成为唯一信息来源）',
    watermark > cloud._dump('bill').find((d) => d._id === 'c1')._serverTs
  )

  // 模拟这台设备时钟倒退：本地改成更旧的 updatedAt
  await a.write('bill', billDoc(clock, 'c1', 20, { updatedAt: clock.now() - 5000 }))
  const localTs = a.get('bill', 'c1').updatedAt
  ok('14a2 本地时间戳确实比云端旧', localTs < cloud._dump('bill').find((d) => d._id === 'c1').updatedAt)

  const r = await a.engine.sync({ manual: true })

  ok('14b 推送被云端拒绝', r.rejected.length === 1, JSON.stringify(r.rejected))
  ok('14c 拒绝原因带回云端时间戳', r.rejected[0].cloudUpdatedAt > localTs)
  eq('14d 本地收敛到云端版本', a.get('bill', 'c1').amount, 10)
  eq('14e 云端没被旧版本覆盖', cloud._dump('bill').find((d) => d._id === 'c1').amount, 10)
  eq('14f 被否决的条目已作废（否则会无限重推）', await a.outbox.pendingCount(), 0)
  ok('14g 水位线在推进', a.watermark() >= watermark)

  await a.engine.sync({ manual: true })
  eq('14h 再同步一次仍是云端版本', a.get('bill', 'c1').amount, 10)
}

/* ========================================================== */
/* 15. 身份隔离                                                */
/* ========================================================== */

group('15. 身份隔离：换身份拉不到别人的文档')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const userA = cloud.as('user_a')
  const userB = cloud.as('user_b')

  await userA.push('bill', [billDoc(clock, 'au1', 1)])
  await userB.push('bill', [billDoc(clock, 'bu1', 2)])

  const seenByA = await userA.pull('bill', { since: 0 })
  const seenByB = await userB.pull('bill', { since: 0 })
  eq('15a A 只看到自己的', seenByA.docs.map((d) => d._id), ['au1'])
  eq('15b B 只看到自己的', seenByB.docs.map((d) => d._id), ['bu1'])
  eq('15c 云端注入了 _openid', cloud._dump('bill', 'user_a')[0]._openid, 'user_a')

  // 引擎级：A 的队列必须推到 A 名下，不能串到 B
  const devA = await makeDevice({ cloud, user: 'user_a', now: clock.now })
  await devA.write('bill', billDoc(clock, 'au2', 3))
  await devA.engine.sync({ manual: true })

  ok('15d A 的新账进了 A 名下', cloud._dump('bill', 'user_a').some((d) => d._id === 'au2'))
  ok('15e B 名下没有 A 的账', !cloud._dump('bill', 'user_b').some((d) => d._id === 'au2'))
  eq('15f B 仍然只有自己的 1 条', cloud._dump('bill', 'user_b').length, 1)
}

/* ========================================================== */
/* 16. 分页拉取                                                */
/* ========================================================== */

group('16. 分页拉取：单页装不下时循环拉，不重不漏')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now, pageSize: 100 })

  const many = []
  for (let i = 0; i < 250; i += 1) {
    many.push(billDoc(clock, `pg${String(i).padStart(3, '0')}`, i + 1))
  }
  await cloud.push('bill', many)
  eq('16a 云端有 250 条', cloud._dump('bill').length, 250)

  let cursor = null
  let got = 0
  let pages = 0
  const ids = new Set()
  do {
    const page = await cloud.pull('bill', { since: 0, cursor, limit: 100 })
    page.docs.forEach((d) => ids.add(d._id))
    got += page.docs.length
    pages += 1
    cursor = page.hasMore ? page.cursor : null
  } while (cursor !== null)

  eq('16b 循环拉到 250 条', got, 250)
  eq('16c 分成 3 页', pages, 3)
  eq('16d 不重不漏', ids.size, 250)

  // 引擎级：一次 sync 就能拉完（内部循环）
  const dev = await makeDevice({ cloud, now: clock.now })
  await dev.engine.sync({ manual: true })
  eq('16e 引擎一次同步拉完 250 条', dev.all('bill').length, 250)
}

/* ========================================================== */
/* 17. 未配置云端时的降级                                       */
/* ========================================================== */

group('17. 未配置云端：引擎静默跳过，不影响本地记账')
{
  const clock = createClock()
  const cold = await makeDevice({ cloud: null, now: clock.now })

  await cold.write('bill', billDoc(clock, 'n1', 1))
  const r = await cold.engine.sync({ manual: true })

  eq('17a 返回 skipped', r.skipped, true)
  eq('17b 原因是 no-cloud', r.reason, 'no-cloud')
  eq('17c 状态保持 idle（不报错）', cold.engine.state, 'idle')
  eq('17d 本地数据照常写入', cold.all('bill').length, 1)
  eq('17e 队列照常积累（等云端接上再推）', await cold.outbox.pendingCount(), 1)

  cold.engine.start()
  await sleep(0)
  eq('17f start 也不会因为没云端而报错', cold.engine.state, 'idle')
  cold.engine.stop()
}

/* ========================================================== */
/* 18. 端到端接线（真实 idbAdapter）                            */
/* ========================================================== */

group('18. 端到端：idbAdapter 写 → outbox → 引擎 → 云端 → 换设备拉回')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })

  const adapter = createIdbAdapter({ dbName: 'ledger_sync_e2e', seed: false })
  const engine = createSyncEngine({
    outbox: adapter.outbox,
    store: adapter.syncStore,
    meta: adapter.kv,
    cloud
  })
  await adapter.ready()

  const created = await adapter.bill.create({
    ledgerId: 'ledger_default',
    type: 'expense',
    amount: 12.5,
    remark: '端到端',
    date: '2026-09-29'
  })

  eq('18a 写入后队列里有 1 条', await adapter.outbox.pendingCount(), 1)
  eq('18b 队列条目指向刚写的账单', (await adapter.outbox.pending())[0].docId, created.id)

  const pushed = await engine.sync({ manual: true })
  eq('18c 同步成功', pushed.ok, true)
  eq('18d 云端有这条', cloud._dump('bill').length, 1)
  eq('18e 云端金额一致', cloud._dump('bill')[0].amount, 12.5)
  eq('18f 云端备注一致', cloud._dump('bill')[0].remark, '端到端')
  eq('18g 队列已清空', await adapter.outbox.pendingCount(), 0)

  // 换一台设备（另一个库、水位从 0 开始）
  const other = createIdbAdapter({ dbName: 'ledger_sync_e2e_b', seed: false })
  const engine2 = createSyncEngine({
    outbox: other.outbox,
    store: other.syncStore,
    meta: other.kv,
    cloud
  })
  await other.ready()
  eq('18h 新设备本地为空', (await other.bill.list({ ledgerId: 'ledger_default' })).length, 0)

  await engine2.sync({ manual: true })
  const restored = await other.bill.list({ ledgerId: 'ledger_default' })
  eq('18i 换设备后完整恢复', restored.length, 1)
  eq('18j 恢复的金额一致', restored[0].amount, 12.5)
  eq('18k 恢复的备注一致', restored[0].remark, '端到端')
  const one = await other.bill.get(restored[0].id)
  eq('18l 按 id 能查回这条账单', one.id, restored[0].id)
  ok(
    '18m 取回时带派生字段（displayName）',
    typeof one.displayName === 'string',
    String(one.displayName)
  )
  eq('18n 落本地时不带云端元数据', Object.keys(restored[0]).filter((k) => k.startsWith('_')), [])
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
