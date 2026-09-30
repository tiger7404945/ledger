/**
 * 边界与并发用例（第二阶段 S4-5）
 * 运行：npm run test:data（或单独 node scripts/conflict-test.mjs）
 *
 * 这个脚本专测「两台设备同时动同一条数据」以及「网络反复断」这两类
 * 最容易被忽略、又最容易造成**静默数据丢失**的场景。
 *
 * ## 为什么单独一个文件
 *
 * sync-test.mjs 测的是调度骨架（该不该同步、失败怎么办），用的是顺序剧本。
 * 这里测的是**边界**：同一毫秒、时钟偏差、拔网恢复、软删除与修改撞车。
 * 它们的共同点是「结果不是显而易见的那一个」——
 * 顺序剧本里永远碰不到，但真实用户一定碰得到。
 *
 * ## 一条贯穿全篇的判据：**无丢失、无重复、两端收敛**
 *
 * 不追求「一定是某一个值」—— 并发下谁赢本来就取决于裁决规则。
 * 追求的是三件事：
 *   ① 不丢：任何一台设备写进去的东西，另一台最终一定看得到（除非被更新的版本覆盖）
 *   ② 不重复：同一条数据不会裂成两条
 *   ③ 收敛：两端最终状态**深度相等**，云端也一样
 * 只要这三条成立，具体取 20 还是 30 是裁决规则的事，不是 bug。
 */

import { createSyncEngine } from '../src/api/sync/syncEngine.js'
import { createFakeCloud } from '../src/api/sync/fakeCloud.js'
import { createOutbox } from '../src/api/sync/outbox.js'
import { createMemoryOutboxStore } from '../src/api/sync/outboxStore.js'
import { partitionRemote } from '../src/api/core/merge.js'
import { SYNC_ERROR_KIND, ERROR_POLICY, classifyError, policyOf } from '../src/api/sync/errors.js'

let pass = 0
let fail = 0

function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass += 1
    console.log(`✓ ${label}`)
  } else {
    fail += 1
    console.log(`✗ ${label}\n    期望 ${e}\n    实得 ${a}`)
  }
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

/** 测试时钟：serverTime 与文档 updatedAt 同源，水位线才自洽 */
function createClock(start = 1_700_000_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms = 1000) => (t += ms),
    stamp: () => (t += 1000),
    set: (v) => {
      t = v
    }
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
 * 内存设备。`now` 必须注入测试时钟 ——
 * S4-2 之后引擎会用 `now()` 算「本地相对服务端的时钟偏差」，
 * 不注入就会拿真实 `Date.now()` 去减测试时钟，偏移荒谬、裁决全乱。
 */
async function makeDevice({ cloud, user = null, timer, isOnline, now, name = 'dev' } = {}) {
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
      const { take, keep } = partitionRemote(locals, docs, clockOffset)
      take.forEach((d) => table(collection).set(d.id, d))
      return { applied: take.length, kept: keep.length }
    },
    /** 服务端刻度写回本地副本（S4-6）。与各适配器同语义：只改刻度、不入 outbox */
    async applyStamps(collection, stamps) {
      let n = 0
      for (const id of Object.keys(stamps || {})) {
        const doc = table(collection).get(id)
        const stamp = Number(stamps[id])
        if (!doc || !Number.isFinite(stamp) || stamp <= 0) continue
        table(collection).set(id, { ...doc, serverUpdatedAt: stamp })
        n += 1
      }
      return n
    }
  }

  const engine = createSyncEngine({
    outbox,
    store,
    meta,
    cloud: user ? cloud.as(user) : cloud,
    ...(now ? { now } : {}),
    ...(timer ? { timer } : {}),
    ...(isOnline ? { isOnline } : {})
  })

  return {
    name,
    outbox,
    engine,
    store,
    watermark: () => watermark,
    async write(collection, doc) {
      table(collection).set(doc.id, { ...doc })
      await outbox.enqueue({ collection, op: 'update', docId: doc.id, payload: { ...doc } })
      return doc
    },
    /** 只改本地 + 入队，不推进时钟 —— 用来构造「同毫秒并发」 */
    async writeNoStamp(collection, doc) {
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
    }
  }
}

const snapshotOf = (doc) => {
  if (!doc) return null
  const { _id, _openid, _serverTs, ...rest } = doc
  void _id
  void _openid
  void _serverTs
  return rest
}

/**
 * 把两台设备同步到「再也同步不出新东西」为止。
 * 收敛类断言必须先把水搅到静止，否则断言的是中间态。
 * 上限 12 轮：正常 3-4 轮就停，留足余量避免死循环。
 */
async function syncToQuiescence(devices, rounds = 12) {
  for (let i = 0; i < rounds; i += 1) {
    let changed = false
    for (const d of devices) {
      const before = d.watermark()
      const r = await d.engine.sync({ manual: true })
      if (r.pushed > 0 || r.pulled > 0 || r.rejected?.length) changed = true
      if (d.watermark() !== before) changed = true
    }
    if (!changed) return i + 1
  }
  return rounds
}

/* ========================================================== */
/* 1. 同时改同一条：A 改金额、B 改备注                          */
/* ========================================================== */

group('1. 并发修改同一笔：A 改金额、B 改备注，两边同时同步')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const a = await makeDevice({ cloud, now: clock.now, name: 'a' })
  const b = await makeDevice({ cloud, now: clock.now, name: 'b' })

  // 起点：两边都拿到同一笔
  await a.write('bill', billDoc(clock, 'x1', 100, { remark: '原备注' }))
  await a.engine.sync({ manual: true })
  await b.engine.sync({ manual: true })
  eq('1a 起点一致', [a.get('bill', 'x1').amount, b.get('bill', 'x1').amount], [100, 100])

  // A 改金额（时钟往前走），B 改备注（时钟更靠后）
  await a.write('bill', billDoc(clock, 'x1', 200, { remark: '原备注' }))
  await b.write('bill', billDoc(clock, 'x1', 100, { remark: 'B 改的备注' }))

  await syncToQuiescence([a, b])

  const fa = snapshotOf(a.get('bill', 'x1'))
  const fb = snapshotOf(b.get('bill', 'x1'))
  const fc = snapshotOf(cloud._dump('bill')[0])

  eq('1b 两端最终深度相等', fa, fb)
  eq('1c 云端与两端一致', fa, fc)
  ok('1d 收敛到 updatedAt 较新的那一版（B 改的）', fa.remark === 'B 改的备注', JSON.stringify(fa))
  eq('1e 没有裂成两条', cloud._dump('bill').length, 1)
  eq('1f 两边的队列都空了', [await a.outbox.pendingCount(), await b.outbox.pendingCount()], [0, 0])
  ok('1g 时钟偏移为 0（测试时钟与服务端同源）', a.engine.snapshot().clockOffset === 0)
}

/* ========================================================== */
/* 2. 同毫秒并发：两边 updatedAt 完全相同                        */
/* ========================================================== */

group('2. 同毫秒并发：updatedAt 完全相同时也不能裂成两条')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const a = await makeDevice({ cloud, now: clock.now, name: 'a' })
  const b = await makeDevice({ cloud, now: clock.now, name: 'b' })

  await a.write('bill', billDoc(clock, 'same', 10))
  await a.engine.sync({ manual: true })
  await b.engine.sync({ manual: true })

  // 刻意用同一个 updatedAt，模拟「同一毫秒两台设备都改了」
  const ts = clock.stamp()
  await a.writeNoStamp('bill', { ...a.get('bill', 'same'), amount: 11, updatedAt: ts })
  await b.writeNoStamp('bill', { ...b.get('bill', 'same'), amount: 12, updatedAt: ts })

  await syncToQuiescence([a, b])

  const fa = snapshotOf(a.get('bill', 'same'))
  const fb = snapshotOf(b.get('bill', 'same'))
  eq('2a 两端最终深度相等', fa, fb)
  eq('2b 没有裂成两条', cloud._dump('bill').length, 1)
  eq('2c 云端也只有一条', cloud._dump('bill').filter((d) => d._id === 'same').length, 1)
  ok('2d 两端取到同一个值', fa.amount === fb.amount, `${fa.amount} vs ${fb.amount}`)
  eq('2e 队列清空', [await a.outbox.pendingCount(), await b.outbox.pendingCount()], [0, 0])
}

/* ========================================================== */
/* 3. 时钟偏差：慢时钟设备的修改不该被静默丢弃 + 跨设备必须收敛      */
/*    （S4-2 修前者；S4-6 修后者，两组断言互相印证）               */
/* ========================================================== */

group('3. 时钟偏差：慢时钟设备的真实新改动必须能推上去，且两端必须收敛')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  /**
   * b 的本地时钟**慢 5 秒**（真实设备常见：系统时间没同步）。
   * 刻意取 5000ms 这个「不巧刚好相等」的量级 —— 校正后本地时间戳会
   * 明显**晚于**云端旧版本（而不是恰好打平），才能干净地验证
   * 「慢时钟的新改动不会被静默丢弃」这件事。打平属于歧义场景（见第 2 组）。
   */
  let slowT = 1_700_000_000_000 - 5000
  const slowClock = {
    now: () => slowT,
    advance: (ms = 1000) => (slowT += ms),
    stamp: () => (slowT += 1000),
    set: (v) => {
      slowT = v
    }
  }

  const a = await makeDevice({ cloud, now: clock.now, name: 'a' })
  const bSlow = await makeDevice({ cloud, now: slowClock.now, name: 'b-slow' })

  await a.write('bill', billDoc(clock, 'sk1', 10))
  await a.engine.sync({ manual: true })
  await bSlow.engine.sync({ manual: true })
  eq('3a 慢时钟设备也拉到了起点', bSlow.get('bill', 'sk1').amount, 10)

  // 慢时钟设备改了一笔。注意：校正的数学本质是把本地时间映射回**真实时间轴**
  // （`localTs + offset == 真实时刻`），所以「在当下改」校正后必然与云端打平 ——
  // 那是歧义场景。这里让**真实时间也往前走了 3 秒**，模拟「b 确实是在
  // 云端那版之后才改的」，校正后应当明确晚于云端版本。
  clock.advance(3000)
  slowClock.advance(3000)
  slowClock.stamp()
  await bSlow.writeNoStamp('bill', {
    ...bSlow.get('bill', 'sk1'),
    amount: 99,
    updatedAt: slowClock.now()
  })
  const localTs = bSlow.get('bill', 'sk1').updatedAt
  const cloudTs = cloud._dump('bill')[0].updatedAt
  ok('3b 慢时钟设备的本地时间戳确实比云端旧', localTs < cloudTs)

  const r = await bSlow.engine.sync({ manual: true })

  // S4-2 的关键效果：引擎取到服务端时间，算出「本地慢 5 秒」，
  // 于是这笔「看起来旧」的改动被正确识别成新改动推上去，而不是静默丢弃。
  ok('3c 引擎算出了正偏移（识别出本机慢）', r.clockOffset > 0, `offset=${r.clockOffset}`)
  eq('3d 这笔改动被推上去了（没被静默丢弃）', cloud._dump('bill')[0].amount, 99)
  eq('3e 推送成功（未被拒）', r.rejected.length, 0)
  // 存进云端的必须是**客户端原始时间戳**，不能是校正后的值 ——
  // 否则偏移会固化进数据、逐轮累积误差（真云端存的就是原始 doc）。
  eq('3e2 云端存的是客户端原始 updatedAt（偏移未被固化）', cloud._dump('bill')[0].updatedAt, localTs)

  // ⚠️ 这一对断言（3f/3g）**在 S4-6 前后是完全相反的** —— 它们是整套用例里
  //    唯一「随实现演进而反转」的地方，改动时务必先读这段。
  //
  //    S4-2 时的已知缺陷：
  //      `clockOffset` 是**每台设备各自算的**，且 `shouldTakeRemote` 只给
  //      「本地那份」加偏移 —— 这等于假设**远端那份的时间戳已经在正确的时间轴上**。
  //      可远端也是某台客户端写的，它同样可能带偏移，而我们不知道它偏多少。
  //      于是两台设备各自「只校正自己」时会掉进**双方都觉得自己更新**的死局：
  //
  //        A 时钟准（offset 0）      ：A 的 10(…001000) + 0      = …001000
  //        B 时钟慢 5s(offset +5000) ：B 的 99(…9999000) + 5000 = …0004000
  //        A 比 → 自己的 …001000 更大 → 保留 10
  //        B 比 → 自己的 …0004000 更大 → 保留 99
  //        ⇒ 两端各自坚持自己那版，**反复同步也不收敛**
  //
  //    S4-6 的修法：**让服务端在接收写入时盖一个共享刻度**（`serverUpdatedAt`）。
  //      推送成功后把刻度**写回写者自己的本地副本**（`store.applyStamps`），
  //      于是两端手里都有一把「与各自本地时钟无关」的尺子：
  //
  //        A 的 10：刻度 T1（A 第一次推送时盖的）
  //        B 的 99：刻度 T4（B 刚才推送时盖的，T4 > T1）
  //        A 拉取 → 比刻度 → T4 更大 → 采纳 B 的 99 ✅
  //        B 拉取 → 自己就是 99，无需变动 ✅
  //        ⇒ **收敛到 99**，且与两端时钟快慢无关
  //
  //      所以下面两条从「钉住缺陷」反转成「验证修复」。
  //      ⚠️ 若有人把 `shouldTakeRemote` 的刻度逻辑改坏（比如参数顺序写反、
  //         或忘了 `applyStamps`），这两条会立刻变红 —— 这正是它们的价值。
  await a.engine.sync({ manual: true })
  eq('3f A 采纳了 B 的版本（共享刻度：B 的写入刻度更晚）', a.get('bill', 'sk1').amount, 99)

  // 【S4-6 已修复】两端在共享刻度下**收敛**，不再各自坚持自己那版。
  await syncToQuiescence([a, bSlow])
  ok(
    '3g 【S4-6 已修复】两端收敛到同一个值（跨设备时钟偏差不再造成静默分叉）',
    a.get('bill', 'sk1').amount === bSlow.get('bill', 'sk1').amount,
    `a=${a.get('bill', 'sk1').amount} b=${bSlow.get('bill', 'sk1').amount}（不相等说明共享刻度裁决没生效）`
  )
  eq('3g2 收敛到的正是 B 的那一版', a.get('bill', 'sk1').amount, 99)
  eq('3g3 两端深度相等（不只是金额）', snapshotOf(a.get('bill', 'sk1')), snapshotOf(bSlow.get('bill', 'sk1')))
  eq('3h 尽管如此，云端仍然只有一条（没有裂成两条文档）', cloud._dump('bill').length, 1)
  eq('3i 两边的队列都排空了（没有无限重推）', [await a.outbox.pendingCount(), await bSlow.outbox.pendingCount()], [0, 0])
}

/* ========================================================== */
/* 4. 快速时钟：快时钟设备不能凭时钟赢                            */
/* ========================================================== */

group('4. 时钟偏差：快时钟设备的陈旧改动不该凭时钟赢')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  // b 的本地时钟**快 1 分钟**：它的 updatedAt 天然比谁都大
  const fastClock = (() => {
    let t = 1_700_000_000_000 + 60000
    return {
      now: () => t,
      advance: (ms = 1000) => (t += ms),
      stamp: () => (t += 1000),
      set: (v) => {
        t = v
      }
    }
  })()

  const a = await makeDevice({ cloud, now: clock.now, name: 'a' })
  const bFast = await makeDevice({ cloud, now: fastClock.now, name: 'b-fast' })

  await a.write('bill', billDoc(clock, 'fk1', 10))
  await a.engine.sync({ manual: true })
  await bFast.engine.sync({ manual: true })

  // B（快时钟）先改，A（正常时钟）后改。
  // 不做校正的话，B 会因为时钟快而在后续任何冲突里都赢 —— 即使它是旧的。
  fastClock.stamp()
  await bFast.writeNoStamp('bill', { ...bFast.get('bill', 'fk1'), amount: 20, updatedAt: fastClock.now() })
  clock.stamp()
  await a.writeNoStamp('bill', { ...a.get('bill', 'fk1'), amount: 30, updatedAt: clock.now() })

  const rb = await bFast.engine.sync({ manual: true })
  ok('4a 快时钟设备算出负偏移（识别出本机快）', rb.clockOffset < 0, `offset=${rb.clockOffset}`)

  await syncToQuiescence([a, bFast])

  const fa = snapshotOf(a.get('bill', 'fk1'))
  const fb = snapshotOf(bFast.get('bill', 'fk1'))
  eq('4b 两端最终深度相等', fa, fb)
  eq('4c 云端与两端一致', fa, snapshotOf(cloud._dump('bill')[0]))
  eq('4d 没有裂成两条', cloud._dump('bill').length, 1)
  eq('4e 队列清空', [await a.outbox.pendingCount(), await bFast.outbox.pendingCount()], [0, 0])
}

/* ========================================================== */
/* 5. 拔网 5 次：无报错、无重复、无丢失                          */
/* ========================================================== */

group('5. 拔网 5 次：恢复后无报错、无重复、无丢失')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const timer = createFakeTimer()
  let online = true
  const a = await makeDevice({ cloud, timer, isOnline: () => online, now: clock.now, name: 'a' })

  // 离线期间写 5 条，每次写完都试一次同步 —— 应该全部静默跳过，一条请求都不发
  online = false
  const beforeCalls = cloud._calls()
  for (let i = 0; i < 5; i += 1) {
    await a.write('bill', billDoc(clock, `off${i}`, 10 + i))
    const r = await a.engine.sync()
    eq(`5a${i + 1} 第 ${i + 1} 次离线同步被跳过`, r.skipped, true)
  }
  eq('5b 离线期间一条请求都没发（省资源点、不污染重试计数）', cloud._calls().push - beforeCalls.push, 0)
  eq('5c 5 条都还在队列里', await a.outbox.pendingCount(), 5)
  eq('5d 离线时状态是 offline（不是 error，不吓用户）', a.engine.state, 'offline')

  // 恢复网络
  online = true
  const recovered = await a.engine.sync({ manual: true })
  eq('5e 恢复后一次同步成功', recovered.ok, true)
  eq('5f 5 条全部推上去', recovered.pushed, 5)
  eq('5g 云端恰好 5 条（没重复）', cloud._dump('bill').length, 5)
  eq('5h 队列清空', await a.outbox.pendingCount(), 0)
  eq('5i 状态回到 idle', a.engine.state, 'idle')

  // 再同步两轮，确认不会重复推
  await a.engine.sync({ manual: true })
  await a.engine.sync({ manual: true })
  eq('5j 多同步两轮云端仍是 5 条', cloud._dump('bill').length, 5)
  eq('5k 本地仍是 5 条', a.all('bill').length, 5)
}

/* ========================================================== */
/* 6. 反复失败恢复：错误累积但不丢数据                            */
/* ========================================================== */

group('6. 反复失败恢复：连续失败 5 次后恢复，数据一条不少')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const timer = createFakeTimer()
  const a = await makeDevice({ cloud, timer, now: clock.now, name: 'a' })

  for (let i = 0; i < 3; i += 1) await a.write('bill', billDoc(clock, `rf${i}`, 10 + i))

  // 连续 5 次失败，每次都让云端抛错
  for (let i = 0; i < 5; i += 1) {
    cloud._failNext(10)
    const r = await a.engine.sync({ manual: true })
    eq(`6a${i + 1} 第 ${i + 1} 次失败`, r.ok, false)
  }
  eq('6b 队列里 3 条一条不少', await a.outbox.pendingCount(), 3)
  eq('6c 本地 3 条一条不丢', a.all('bill').length, 3)
  eq('6d 云端还是空的', cloud._dump('bill').length, 0)

  cloud._failNext(0)
  const r = await a.engine.sync({ manual: true })
  eq('6e 恢复后一次成功', r.ok, true)
  eq('6f 3 条全部补推', cloud._dump('bill').length, 3)
  eq('6g 队列清空', await a.outbox.pendingCount(), 0)
  eq('6h 没有重复', cloud._dump('bill').filter((d) => d._id.startsWith('rf')).length, 3)
}

/* ========================================================== */
/* 7. 软删除撞上修改                                            */
/* ========================================================== */

group('7. 软删除撞上修改：删除态不会被旧修改复活')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const a = await makeDevice({ cloud, now: clock.now, name: 'a' })
  const b = await makeDevice({ cloud, now: clock.now, name: 'b' })

  await a.write('bill', billDoc(clock, 'dd1', 50))
  await a.engine.sync({ manual: true })
  await b.engine.sync({ manual: true })

  // A 删除（更晚），B 同时改金额（更早）
  await a.softDelete('bill', 'dd1', clock.stamp())
  await b.write('bill', billDoc(clock, 'dd1', 60, { updatedAt: clock.now() - 8000 }))

  await syncToQuiescence([a, b])

  eq('7a 两端深度相等', snapshotOf(a.get('bill', 'dd1')), snapshotOf(b.get('bill', 'dd1')))
  eq('7b 删除态获胜（它更晚）', a.get('bill', 'dd1').deleted, 1)
  eq('7c 云端也是删除态', cloud._dump('bill')[0].deleted, 1)
  eq('7d 没有裂成两条', cloud._dump('bill').length, 1)
  eq('7e 队列清空', [await a.outbox.pendingCount(), await b.outbox.pendingCount()], [0, 0])

  // 再同步两轮，删除态必须稳住（不能被「复活」）
  await a.engine.sync({ manual: true })
  await b.engine.sync({ manual: true })
  eq('7f 再同步仍是删除态', a.get('bill', 'dd1').deleted, 1)
  eq('7g 云端仍是删除态', cloud._dump('bill')[0].deleted, 1)
}

/* ========================================================== */
/* 8. 删除与新建同 id：新文档不该被旧的删除态污染                */
/* ========================================================== */

group('8. 软删除后同 id 重建：新文档的 updatedAt 更晚，应当复活')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const a = await makeDevice({ cloud, now: clock.now, name: 'a' })

  await a.write('bill', billDoc(clock, 'rv1', 10))
  await a.engine.sync({ manual: true })

  await a.softDelete('bill', 'rv1', clock.stamp())
  await a.engine.sync({ manual: true })
  eq('8a 已删除', a.get('bill', 'rv1').deleted, 1)

  // 用户后悔了，重新记一笔（同 id，更新时间更晚）
  clock.stamp()
  await a.writeNoStamp('bill', {
    ...a.get('bill', 'rv1'),
    amount: 77,
    deleted: 0,
    updatedAt: clock.now()
  })
  await a.engine.sync({ manual: true })

  eq('8b 复活成功（updatedAt 更晚，删除态被覆盖）', a.get('bill', 'rv1').deleted, 0)
  eq('8c 金额是新的', a.get('bill', 'rv1').amount, 77)
  eq('8d 云端也是复活态', cloud._dump('bill')[0].deleted, 0)
  eq('8e 云端金额一致', cloud._dump('bill')[0].amount, 77)
}

/* ========================================================== */
/* 9. 三台设备同时改                                            */
/* ========================================================== */

group('9. 三台设备同时改同一条：最终仍收敛到同一版本')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const a = await makeDevice({ cloud, now: clock.now, name: 'a' })
  const b = await makeDevice({ cloud, now: clock.now, name: 'b' })
  const c = await makeDevice({ cloud, now: clock.now, name: 'c' })

  await a.write('bill', billDoc(clock, 'tri', 1))
  await a.engine.sync({ manual: true })
  await b.engine.sync({ manual: true })
  await c.engine.sync({ manual: true })

  await a.write('bill', billDoc(clock, 'tri', 2))
  await b.write('bill', billDoc(clock, 'tri', 3))
  await c.write('bill', billDoc(clock, 'tri', 4))

  await syncToQuiescence([a, b, c])

  const sa = snapshotOf(a.get('bill', 'tri'))
  eq('9a 三台设备深度相等（a=b）', sa, snapshotOf(b.get('bill', 'tri')))
  eq('9b 三台设备深度相等（a=c）', sa, snapshotOf(c.get('bill', 'tri')))
  eq('9c 云端与三台一致', sa, snapshotOf(cloud._dump('bill')[0]))
  eq('9d 收敛到最晚的一版（c 的 4）', sa.amount, 4)
  eq('9e 没有裂成多条', cloud._dump('bill').length, 1)
  eq(
    '9f 三边队列都空了',
    [await a.outbox.pendingCount(), await b.outbox.pendingCount(), await c.outbox.pendingCount()],
    [0, 0, 0]
  )
}

/* ========================================================== */
/* 10. 批量混合操作：增改删一起上，逐条核对                       */
/* ========================================================== */

group('10. 混合操作：新增 / 修改 / 删除一起同步，逐条核对无丢失')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const a = await makeDevice({ cloud, now: clock.now, name: 'a' })
  const b = await makeDevice({ cloud, now: clock.now, name: 'b' })

  // 先在云端造 6 条
  const seed = []
  for (let i = 0; i < 6; i += 1) seed.push(billDoc(clock, `mix${i}`, 10 * (i + 1)))
  await cloud.push('bill', seed)
  await a.engine.sync({ manual: true })
  await b.engine.sync({ manual: true })
  eq('10a 两边都拉到 6 条', [a.all('bill').length, b.all('bill').length], [6, 6])

  // A：改 2 条 + 删 1 条 + 新增 2 条
  await a.write('bill', billDoc(clock, 'mix0', 111))
  await a.write('bill', billDoc(clock, 'mix1', 222))
  await a.softDelete('bill', 'mix2', clock.stamp())
  await a.write('bill', billDoc(clock, 'new1', 501))
  await a.write('bill', billDoc(clock, 'new2', 502))

  await syncToQuiescence([a, b])

  // 逐条核对 B 的视角
  eq('10b 修改的 mix0 传播过去', b.get('bill', 'mix0').amount, 111)
  eq('10c 修改的 mix1 传播过去', b.get('bill', 'mix1').amount, 222)
  eq('10d 删除的 mix2 是删除态', b.get('bill', 'mix2').deleted, 1)
  ok('10e 新增的 new1 传播过去', !!b.get('bill', 'new1'))
  ok('10f 新增的 new2 传播过去', !!b.get('bill', 'new2'))
  eq('10g 未动的 mix3 保持原值', b.get('bill', 'mix3').amount, 40)
  eq('10h B 现在有 8 条（6 - 0 + 2）', b.all('bill').length, 8)
  eq('10i 云端 8 条', cloud._dump('bill').length, 8)

  // 深度核对：两端每一条都相等
  const keys = [...new Set([...a.all('bill'), ...b.all('bill')].map((d) => d.id))].sort()
  const mismatched = keys.filter((k) => JSON.stringify(snapshotOf(a.get('bill', k))) !== JSON.stringify(snapshotOf(b.get('bill', k))))
  eq('10j 逐条比对：两端没有一条不一致', mismatched, [])
  eq('10k 队列清空', [await a.outbox.pendingCount(), await b.outbox.pendingCount()], [0, 0])
}

/* ========================================================== */
/* 11. 错误分类：分类结果与策略表一致                            */
/* ========================================================== */

group('11. 错误分类：每类错误的判定与策略')
{
  // 离线
  const offline = classifyError(new Error('boom'), { online: false })
  eq('11a 浏览器离线 → offline（静默）', offline, SYNC_ERROR_KIND.OFFLINE)
  eq('11b offline 是 silent', policyOf(offline).silent, true)
  eq('11c offline 不重试（没网重试没意义）', policyOf(offline).retryable, false)

  // 带标记的异常：适配器打 kind 标记是主路径
  const mk = (kind, msg = 'x') => {
    const e = new Error(msg)
    e.kind = kind
    return e
  }
  eq('11d 适配器标记 kind 优先', classifyError(mk(SYNC_ERROR_KIND.QUOTA)), SYNC_ERROR_KIND.QUOTA)
  eq('11e 配额类不可重试', policyOf(SYNC_ERROR_KIND.QUOTA).retryable, false)
  eq('11f 权限类不可重试', policyOf(SYNC_ERROR_KIND.FORBIDDEN).retryable, false)
  eq('11g 冲突类不可重试', policyOf(SYNC_ERROR_KIND.CONFLICT).retryable, false)
  eq('11h 登录失效要重新登录', policyOf(SYNC_ERROR_KIND.AUTH_EXPIRED).needsReauth, true)
  eq('11i 登录失效不该退避重试（退避永远好不了）', policyOf(SYNC_ERROR_KIND.AUTH_EXPIRED).retryable, false)
  eq('11j 服务端错误可重试', policyOf(SYNC_ERROR_KIND.SERVER).retryable, true)
  eq('11k 网络错误可重试', policyOf(SYNC_ERROR_KIND.NETWORK).retryable, true)

  // 未标记的异常靠兜底：错误码 / 文案
  const quotaLike = new Error('quota exceeded')
  ok('11l 兜底能认出配额类文案', classifyError(quotaLike) === SYNC_ERROR_KIND.QUOTA, classifyError(quotaLike))
  const e11000 = new Error('E11000 duplicate key error collection')
  eq('11m 兜底能认出主键冲突', classifyError(e11000), SYNC_ERROR_KIND.CONFLICT)
  const forbidden = new Error('PERMISSION_DENIED')
  eq('11n 兜底能认出权限被拒', classifyError(forbidden), SYNC_ERROR_KIND.FORBIDDEN)

  // 未知错误保守按可重试处理
  eq('11o 未知错误兜底为 unknown', classifyError(new Error('随便什么奇怪错误')), SYNC_ERROR_KIND.UNKNOWN)
  eq('11p unknown 保守地可重试', policyOf(SYNC_ERROR_KIND.UNKNOWN).retryable, true)

  // 每类都必须有策略，否则视图拿不到文案
  const kinds = Object.values(SYNC_ERROR_KIND)
  const missing = kinds.filter((k) => !ERROR_POLICY[k]?.label)
  eq('11q 每一类都有 label（视图直接可显示）', missing, [])
  const noBool = kinds.filter(
    (k) =>
      typeof ERROR_POLICY[k].retryable !== 'boolean' ||
      typeof ERROR_POLICY[k].needsReauth !== 'boolean' ||
      typeof ERROR_POLICY[k].silent !== 'boolean'
  )
  eq('11r 每一类的三个策略位都是布尔', noBool, [])
}

/* ========================================================== */
/* 12. 引擎级：错误分类真的改变了处置                            */
/* ========================================================== */

group('12. 引擎级：不可重试的错误不该进退避队列')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const timer = createFakeTimer()
  const a = await makeDevice({ cloud, timer, now: clock.now, name: 'a' })

  await a.write('bill', billDoc(clock, 'q1', 1))

  // 配额耗尽：持续失败、且不可自愈
  cloud._failAlways({ kind: SYNC_ERROR_KIND.QUOTA, message: '配额用完' })
  const r = await a.engine.sync({ manual: true })

  eq('12a 同步失败', r.ok, false)
  eq('12b 分类为 quota', r.kind, SYNC_ERROR_KIND.QUOTA)
  eq('12c 标记为不可重试', r.retryable, false)
  eq('12d 没有安排退避重试（重试只是白烧资源点）', timer.delays(), [])
  eq('12e 队列里的 retry 计数没被加（否则看起来像网差）', (await a.outbox.pending())[0].retry, 0)
  eq('12f 状态进 error（要告诉用户）', a.engine.state, 'error')
  ok('12g lastError 带 label 可直接显示', !!a.engine.lastError?.label, JSON.stringify(a.engine.lastError))
  eq('12h 数据没丢', a.all('bill').length, 1)

  // 换成可重试的网络错误：这次应该安排退避
  cloud._failAlways(null)
  cloud._failNext(10)
  const r2 = await a.engine.sync({ manual: true })
  eq('12i 网络错误仍是失败', r2.ok, false)
  // fakeCloud 的 `_failNext` 抛的是**没有任何码的裸 Error**，正是真实世界里
  // fetch / SDK 包装层最常见的形态。它不该被认成 UNKNOWN（那会掩盖真因），
  // 但至少必须落在**可重试**的一类里 —— 这才是 12k 真正要保证的事。
  ok(
    '12j 无码异常落在可重试类别（network/server/unknown）',
    [SYNC_ERROR_KIND.NETWORK, SYNC_ERROR_KIND.SERVER, SYNC_ERROR_KIND.UNKNOWN].includes(r2.kind),
    `kind=${r2.kind}`
  )
  eq('12j2 它确实是可重试的', r2.retryable, true)
  ok('12k 可重试类安排了退避', timer.delays().includes(2000), JSON.stringify(timer.delays()))

  cloud._failNext(0)
  const r3 = await a.engine.sync({ manual: true })
  eq('12l 恢复后成功', r3.ok, true)
  eq('12m 队列清空', await a.outbox.pendingCount(), 0)
  eq('12n 连续失败计数归零', a.engine.snapshot().consecutiveFailures, 0)
}

/* ========================================================== */
/* 13. 时钟偏移的降级：云函数不可用时不采信下界                   */
/* ========================================================== */

group('13. 时钟降级：serverTime 只给下界时，偏移必须按 0 处理')
{
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const a = await makeDevice({ cloud, now: clock.now, name: 'a' })

  await a.write('bill', billDoc(clock, 'dg1', 1))
  const r = await a.engine.sync({ manual: true })
  eq('13a 正常时 source 是 cloud-function', r.clockSource, 'cloud-function')

  // 模拟云函数不可用 → serverTime 降级成「水位线下界」
  cloud._serverTimeSource('watermark-lower-bound')
  const r2 = await a.engine.sync({ manual: true })
  eq('13b 降级时 source 变成 watermark-lower-bound', r2.clockSource, 'watermark-lower-bound')
  eq('13c ★ 降级时不采信偏移（下界不是当前时间，拿它算会推慢本地时钟）', r2.clockOffset, 0)
  eq('13d 同步照常成功（时钟校正不是必需品）', r2.ok, true)

  // 数据仍然能同步（降级不影响功能，只是裁决退回纯客户端时钟）
  await a.write('bill', billDoc(clock, 'dg2', 2))
  const r3 = await a.engine.sync({ manual: true })
  eq('13e 降级期间写入照样推送', r3.pushed, 1)
  eq('13f 云端两条', cloud._dump('bill').length, 2)

  cloud._serverTimeSource('cloud-function')
}

/* ========================================================== */
/* 14. S4-6：服务端共享刻度的两条边界 —— 降级 与 刻度失效          */
/* ========================================================== */

group('14. S4-6 边界：云函数不可用时降级 + 本地再改后刻度必须失效')
{
  /**
   * 14-A. **降级**：云函数没部署 / 网关不通时，推送写进去的文档没有 `serverUpdatedAt`。
   *       裁决必须**静默退回 S4-2 的「客户端时间戳 + 单侧校正」**，既不报错也不卡住。
   *       刻度是增强，不是必需品 —— 缺了它同步照常工作。
   */
  const clock = createClock()
  const cloud = createFakeCloud({ clock: clock.now })
  const a = await makeDevice({ cloud, now: clock.now, name: 'a' })
  const b = await makeDevice({ cloud, now: clock.now, name: 'b' })

  cloud._noServerStamp(true) // 模拟「云函数不可用」

  await a.write('bill', billDoc(clock, 'ns1', 10))
  const r1 = await a.engine.sync({ manual: true })
  eq('14a 云函数不可用时同步照常成功（不报错、不卡住）', r1.ok, true)
  eq('14b 没有刻度也一样推上去了', r1.pushed, 1)
  eq('14c 云端这份确实没有刻度（降级属实）', cloud._dump('bill')[0].serverUpdatedAt, undefined)

  await b.engine.sync({ manual: true })
  eq('14d 另一台设备照样拉到（降级不影响读写）', b.get('bill', 'ns1').amount, 10)
  await syncToQuiescence([a, b])
  eq(
    '14e 降级下两端仍收敛（退回客户端时钟比较，测试时钟同源所以不冲突）',
    snapshotOf(a.get('bill', 'ns1')),
    snapshotOf(b.get('bill', 'ns1'))
  )

  /**
   * 14-B. **刻度失效判据**：本地文档一旦被再次修改，随它同步下来的
   *       `serverUpdatedAt` 标的就是**上一版内容**，不能再用来裁决 ——
   *       否则「刚从云端拉下来的旧刻度」会把本地**刚改的新内容**判成不新，
   *       同步时用云端旧内容覆盖回去，用户白改。
   *
   *       判据是「本地 `updatedAt` 晚于刻度 ⇒ 刻度失效」（见 merge.js）。
   */
  cloud._noServerStamp(false)
  const clock2 = createClock()
  const cloud2 = createFakeCloud({ clock: clock2.now })
  const c = await makeDevice({ cloud: cloud2, now: clock2.now, name: 'c' })

  await c.write('bill', billDoc(clock2, 'iv1', 1))
  await c.engine.sync({ manual: true })
  const stampAfterPush = c.get('bill', 'iv1').serverUpdatedAt
  ok('14f 推送成功后本地副本拿到了服务端刻度', Number(stampAfterPush) > 0, String(stampAfterPush))

  // 时钟前进 → 本地改成 v2（updatedAt 必然晚于刻度）
  clock2.stamp()
  clock2.stamp() // 多走一点，确保严格晚于刻度
  await c.write('bill', { ...c.get('bill', 'iv1'), amount: 42, updatedAt: clock2.now() })
  const localV2 = c.get('bill', 'iv1')
  ok(
    '14g 本地 v2 的内容时间晚于随它同步下来的刻度（这正是「刻度已失效」的判据）',
    localV2.updatedAt > Number(localV2.serverUpdatedAt),
    `updatedAt=${localV2.updatedAt} stamp=${localV2.serverUpdatedAt}`
  )

  const r2 = await c.engine.sync({ manual: true })
  eq('14h 本地新改动推上去了（没被自己那份旧刻度挡住）', r2.pushed, 1)
  eq('14i 云端是 v2', cloud2._dump('bill')[0].amount, 42)
  ok(
    '14j 云端刻度被刷新成更晚的值（标记的是 v2 这次写入）',
    Number(cloud2._dump('bill')[0].serverUpdatedAt) > Number(stampAfterPush),
    `${cloud2._dump('bill')[0].serverUpdatedAt} vs ${stampAfterPush}`
  )
  eq('14k 本地 v2 的刻度也同步刷新了', c.get('bill', 'iv1').serverUpdatedAt, cloud2._dump('bill')[0].serverUpdatedAt)
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
