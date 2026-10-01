/**
 * S5-4 / S5-7 断言：账号与本地数据交接的两条规则
 * ------------------------------------------------------------
 * S5-4（退出登录的数据处置）
 *   「先把改动全部推上云，再清本地副本」。测试盯的是**清库语义**：
 *   清业务数据 + 清水位线，但必须留下 schemaVersion / seedMeta / 导入标记 ——
 *   清了它们，下次开库会重新播种并把 localStorage 的旧库再导入一遍。
 *
 * S5-7（首次绑定改为询问用户）
 *   云端**已有该账号的数据**时，本地不再无脑「本地优先」推上去，
 *   而是先返回 `needs-decision` 让用户选：
 *     - `push-local` —— 本地整体入队推上去；
 *     - `keep-cloud` —— 舍弃本地，**连水位线一起清**，靠全量回拉恢复。
 *   水位线不清是这套逻辑里最阴的坑：留着它，下次登录是增量拉取，
 *   而云端文档的 `_serverTs` 都早于水位，一条都拉不回来，
 *   用户会看到一个**空账号**（数据其实还在云端）。
 *
 * 这里能测的：判定分支、清库保留项、入队条数（fake-indexeddb + 假云端）。
 * 这里测不了的：弹框交互与真实云端权限 —— 靠浏览器走查 + `.preview/` 探针。
 *
 * 运行：node scripts/firstbind-test.mjs（已并入 npm run test:data）
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

const { createIdbAdapter } = await import(`${SRC}api/adapters/idbAdapter.js`)
const {
  ensureFirstBind,
  resolveFirstBind,
  readPendingFirstBind,
  cloudHasData,
  countLocalDocs,
  FIRST_BIND_DONE_KEY,
  SYNC_WATERMARK_KEY
} = await import(`${SRC}api/core/firstBind.js`)

let pass = 0
let fail = 0
const ok = (name, cond, detail) => {
  if (cond) {
    pass += 1
    console.log('✓ ' + name)
  } else {
    fail += 1
    console.log('✗ ' + name + (detail ? '  — ' + detail : ''))
  }
}

let seq = 0
const newDb = () => createIdbAdapter({ dbName: `ledger_test_fb_${seq++}_${Date.now()}`, seed: true })

/** 只实现契约里那几个方法的最小假云端 */
const makeCloud = ({ docs = {}, fail: shouldFail = false } = {}) => ({
  async pull(collection, options = {}) {
    if (shouldFail) throw new Error('cloud down')
    const list = docs[collection] || []
    const limit = options.limit ?? 100
    return {
      docs: list.slice(0, limit),
      serverTime: 1000,
      hasMore: list.length > limit,
      cursor: null
    }
  }
})
const emptyCloud = () => makeCloud()
const row = (id) => ({ id, _serverTs: 1 })

/* ---------------- 1. 「云端有没有数据」的探测 ---------------- */

ok('1a 云端空 → 判定为没有数据', (await cloudHasData(emptyCloud())) === false)
ok('1b 云端有账单 → 有数据', (await cloudHasData(makeCloud({ docs: { bill: [row('b1')] } }))) === true)
ok('1c 只有分类/账本也算有数据', (await cloudHasData(makeCloud({ docs: { category: [row('c1')] } }))) === true)
ok('1d 探测抛错时当作「没有」（不卡住绑定）', (await cloudHasData(makeCloud({ fail: true }))) === false)
ok('1e 没配云端 → 没有数据', (await cloudHasData(null)) === false)

/* ---------------- 2. 云端为空：维持「本地优先」 ---------------- */

const db1 = newDb()
await db1.ready()
const seeded1 = await countLocalDocs(db1)
ok('2a 播种后本地确实有数据', seeded1 > 0, String(seeded1))

const r1 = await ensureFirstBind({ db: db1, cloud: emptyCloud() })
ok(
  '2b 云端空 → 本地整体入队',
  r1.ok === true && r1.queued > 0 && r1.queued === r1.localCount,
  JSON.stringify(r1)
)
ok('2c 入队条数 = 待推条数', (await db1.outbox.pendingCount()) === r1.queued)
ok('2d 写了「首绑已处理」标记', Boolean(await db1.kv.get(FIRST_BIND_DONE_KEY)))

const r1b = await ensureFirstBind({ db: db1, cloud: emptyCloud() })
ok('2e 幂等：再调一次直接跳过', r1b.skipped === true && r1b.reason === 'already-bound', JSON.stringify(r1b))

/* ---------------- 3. 有水位线：认定同步过，不再整体入队 ---------------- */

const db2 = newDb()
await db2.ready()
await db2.kv.set(SYNC_WATERMARK_KEY, 12345)
const r2 = await ensureFirstBind({ db: db2, cloud: emptyCloud() })
ok(
  '3a 有水位线 → already-synced（不重复整体入队）',
  r2.skipped === true && r2.reason === 'already-synced',
  JSON.stringify(r2)
)
ok('3b 顺手把标记补上', Boolean(await db2.kv.get(FIRST_BIND_DONE_KEY)))
ok('3c 没有新增队列', (await db2.outbox.pendingCount()) === 0)

/* ---------------- 4. 云端已有数据：交给用户裁决 ---------------- */

const db3 = newDb()
await db3.ready()
const cloud3 = makeCloud({ docs: { bill: [row('b1')] } })
const localCount3 = await countLocalDocs(db3)

const r3 = await ensureFirstBind({ db: db3, cloud: cloud3 })
ok(
  '4a 云端有数据 → needs-decision（不擅自本地优先）',
  r3.skipped === true && r3.reason === 'needs-decision',
  JSON.stringify(r3)
)
ok('4b 裁决前不写标记（下次还得问）', !(await db3.kv.get(FIRST_BIND_DONE_KEY)))
ok('4c 裁决前不擅自入队', (await db3.outbox.pendingCount()) === 0)
ok('4d localCount 报的是本机文档数', r3.localCount === localCount3 && localCount3 > 0, JSON.stringify(r3))

const r3b = await ensureFirstBind({ db: db3, cloud: cloud3 })
ok('4e 再问一次仍是 needs-decision', r3b.reason === 'needs-decision', JSON.stringify(r3b))

// 为什么要有这个标记：main.js 启动那次判定没人接住，引擎的 startup 同步又会把
// 水位线写回去，之后判定就短路成 already-synced —— 弹框永远出不来
const flagged3 = await readPendingFirstBind({ db: db3 })
ok(
  '4f needs-decision 落盘成「待裁决」标记（否则弹框会被 startup 同步吃掉）',
  flagged3?.localCount === localCount3,
  JSON.stringify(flagged3)
)

ok(
  '4g 没有键值仓（mock 数据源）→ no-kv',
  (await ensureFirstBind({ db: {}, cloud: emptyCloud() })).reason === 'no-kv'
)

/* ---------------- 5. 裁决：推本地 ---------------- */

const db4 = newDb()
await db4.ready()
const localCount4 = await countLocalDocs(db4)
const p4 = await resolveFirstBind({ choice: 'push-local', db: db4 })
ok('5a 推本地：入队条数 = 本地文档数', p4.ok === true && p4.queued === localCount4, JSON.stringify(p4))
ok('5b 推本地：队列里有对应条数', (await db4.outbox.pendingCount()) === localCount4)
ok('5c 推本地：写了标记', Boolean(await db4.kv.get(FIRST_BIND_DONE_KEY)))
ok('5d 推本地：本地数据一条不动', (await countLocalDocs(db4)) === localCount4)
ok('5e 推本地：不会留下「待裁决」标记', (await readPendingFirstBind({ db: db4 })) === null)

/* ---------------- 6. 裁决：保留云端（舍弃本地） ---------------- */

const db5 = newDb()
await db5.ready()
const localCount5 = await countLocalDocs(db5)
await db5.kv.set(SYNC_WATERMARK_KEY, 888)
await db5.kv.set('customFlag', 'keep-me')

const k5 = await resolveFirstBind({ choice: 'keep-cloud', db: db5 })
ok('6a 保留云端：本地业务数据清空', k5.discarded === true && (await countLocalDocs(db5)) === 0, JSON.stringify(k5))
ok('6b 保留云端：清库前确有数据（对照）', localCount5 > 0, String(localCount5))
ok('6c 保留云端：**水位线被清**（否则下次一条都拉不回来）', (await db5.kv.get(SYNC_WATERMARK_KEY)) == null)
ok('6d 保留云端：队列也清空', (await db5.outbox.pendingCount()) === 0)
ok('6e 保留云端：写了标记（一次性裁决）', Boolean(await db5.kv.get(FIRST_BIND_DONE_KEY)))
ok('6f 保留云端：其它 meta 原样保留', (await db5.kv.get('customFlag')) === 'keep-me')

// 先人为埋一个「待裁决」标记，验证裁决完成后会被清掉
const db5b = newDb()
await db5b.ready()
await ensureFirstBind({ db: db5b, cloud: makeCloud({ docs: { bill: [row('b1')] } }) })
const beforeResolve = await readPendingFirstBind({ db: db5b })
await resolveFirstBind({ choice: 'keep-cloud', db: db5b })
ok('6g 裁决前确实有「待裁决」标记（对照）', Boolean(beforeResolve), JSON.stringify(beforeResolve))
ok('6h 裁决后标记被清（不会再问）', (await readPendingFirstBind({ db: db5b })) === null)

/* ---------------- 7. 清库语义：该留的别清 ---------------- */

const db6 = newDb()
await db6.ready()
const seeded6 = await countLocalDocs(db6)
await db6.kv.set(SYNC_WATERMARK_KEY, 999)
await db6.clearLocalData()

ok('7a 清库后业务数据为 0', (await countLocalDocs(db6)) === 0)
ok('7b 清库前确有数据（对照）', seeded6 > 0, String(seeded6))
ok('7c 水位线被清', (await db6.kv.get(SYNC_WATERMARK_KEY)) == null)
ok('7d schemaVersion 保留（否则下次开库会重新播种）', Boolean(await db6.kv.get('schemaVersion')))
ok('7e seedMeta 保留', Boolean(await db6.kv.get('seedMeta')))
await db6.ready()
ok('7f 清库后不会重新播种（保持空库，等云端回拉）', (await countLocalDocs(db6)) === 0)

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
