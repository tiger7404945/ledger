/**
 * S5-5 断言：本地库按账号分区 + 旧库继承
 * ------------------------------------------------------------
 * 这一组盯住的是 **S5 之前只有一个裸库 `ledger`** 留下的两个问题：
 *
 *   问题 1（串号）：一台设备先后登录两个账号时，两账号共用同一个库，
 *      A 残留的 outbox 条目会被下一轮同步推到 **B 名下**（云端 `_openid` 是 B 的）。
 *      数据本身有服务端 `_openid` 隔离兜底，但**本地队列没有身份概念**——
 *      这就是「串号」的真实形态。
 *
 *   问题 2（数据看起来丢了）：第一次按账号分区时，如果直接开一个空的分区库，
 *      用户会以为「记账全没了」——数据其实好好躺在旧库 `ledger` 里。
 *
 * 这里能测的（纯函数 + fake-indexeddb）：
 *   - 库名派生规则（前缀、空值兜底、与云端别名前缀同源）
 *   - 分区库确实互相隔离（两个账号各写各的，读不到对方）
 *   - 旧库 → 分区库的继承（幂等、不覆盖、带标记）
 *   - 继承时**不播种**（否则种子会盖掉继承来的数据）
 *
 * 这里**测不了**的：真实浏览器的多标签页并发、真实云端 `_openid` 隔离
 * —— 前者靠手工走查，后者靠 `.preview/sdk-probe/probe-isolation.mjs`。
 *
 * 运行：node scripts/partition-test.mjs（已并入 npm run test:data）
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

const {
  DB_NAME,
  DB_VERSION,
  DB_PARTITION_PREFIX,
  LEGACY_DB_KEY,
  LEGACY_OUTBOX_KEY,
  META_KEYS,
  STORES,
  createIdbConnection,
  isPartitionedDbName,
  isConnClosedError,
  migratePartitionData,
  openDB,
  partitionedDbName,
  putMany,
  readAll,
  readMeta,
  writeMeta
} = await import(`${SRC}api/core/idb.js`)
const { accountPrefixOf } = await import(`${SRC}api/core/cloudId.js`)
const { createIdbAdapter } = await import(`${SRC}api/adapters/idbAdapter.js`)
const { SCHEMA_VERSION } = await import(`${SRC}api/contract.js`)

/* 断言与汇总统一走 scripts/_harness.mjs（输出格式见该文件顶部说明） */
import { createSuite } from './_harness.mjs'
import { readFileSync } from 'node:fs'

const t = createSuite('partition-test')

/** 每个用例用独立库名，避免相互污染 */
let seq = 0
const nextDb = (label) => `t_part_${label}_${++seq}`

/* ---------------- 1. 库名派生 ---------------- */

t.group('1. partitionedDbName：账号前缀 → 分区库名')

t.ok('1a 前缀拼在下划线后', partitionedDbName('hvfpnrlq') === 'ledger_hvfpnrlq')
t.ok('1b 与 DB_PARTITION_PREFIX 一致', partitionedDbName('abc') === `${DB_PARTITION_PREFIX}abc`)
t.ok('1c 空前缀退回裸 DB_NAME（不开出 ledger_ 半截名）', partitionedDbName('') === DB_NAME)
t.ok('1d null/undefined 同样兜底', partitionedDbName(null) === DB_NAME && partitionedDbName(undefined) === DB_NAME)
t.ok('1e 只去首尾空白', partitionedDbName('  ab  ') === 'ledger_ab')
t.ok('1f 别名库名可识别', isPartitionedDbName('ledger_abc') === true)
t.ok('1g 裸库不算分区库', isPartitionedDbName(DB_NAME) === false)
t.ok('1h 别的库名不算', isPartitionedDbName('ledgerdb') === false && isPartitionedDbName(null) === false)

/* ---------------- 2. 与云端别名前缀同源 ---------------- */

t.group('2. 本地分区库名与云端 _id 别名前缀**同源**（同一套 accountPrefixOf）')

const UID_A = 'hVfpnRlq_AbAFDKrd4sxpw'
const UID_B = 'kqjV1DcPvon2m-UE0E0XMQ'

t.ok('2a 两个真实 uid 派生的库名不同', partitionedDbName(accountPrefixOf(UID_A)) !== partitionedDbName(accountPrefixOf(UID_B)))
t.ok(
  '2b 库名 = ledger_ + 云端别名前缀',
  partitionedDbName(accountPrefixOf(UID_A)) === `ledger_${accountPrefixOf(UID_A)}`
)
t.ok('2c 前缀长度仍是 8（两处一致）', accountPrefixOf(UID_A).length === 8)

/* ---------------- 3. 分区隔离（两个账号各写各的） ---------------- */

t.group('3. 分区隔离：两个账号的库互不可见')

const dbA = nextDb('acctA')
const dbB = nextDb('acctB')

const adapterA = createIdbAdapter({ dbName: dbA, seed: false })
const adapterB = createIdbAdapter({ dbName: dbB, seed: false })
await adapterA.ready()
await adapterB.ready()

// ⚠️ `ledgerApi` 没有 `create`（账本由种子/接管产生，用户不新建账本）。
//    这里直接写 objectStore，模拟两个账号各自的库里各有一本账本。
const rawA = await openDB({ dbName: dbA, version: DB_VERSION })
const rawB = await openDB({ dbName: dbB, version: DB_VERSION })
await putMany(rawA, STORES.LEDGER, [{ id: 'ledger_default', name: 'A 的账本', currency: 'CNY', updatedAt: 1 }])
await putMany(rawB, STORES.LEDGER, [{ id: 'ledger_default', name: 'B 的账本', currency: 'CNY', updatedAt: 1 }])

const aLedgers = await adapterA.ledger.list()
const bLedgers = await adapterB.ledger.list()

t.ok('3a A 只看到自己的账本', aLedgers.length === 1 && aLedgers[0].name === 'A 的账本', JSON.stringify(aLedgers.map((l) => l.name)))
t.ok('3b B 只看到自己的账本', bLedgers.length === 1 && bLedgers[0].name === 'B 的账本', JSON.stringify(bLedgers.map((l) => l.name)))
t.ok('3c 同一 id 在两库里各自独立', aLedgers[0].id === bLedgers[0].id && aLedgers[0].name !== bLedgers[0].name)

/* ---------------- 4. 串号防住：A 的队列不会被 B 看到 ---------------- */

t.group('4. ★ 串号防住：outbox 也随库分区')

// ⚠️ `billApi.create` 自己生成 id（`uid('bill')`），不认外部传入的 id
const createdA = await adapterA.bill.create({
  ledgerId: 'ledger_default',
  categoryId: null,
  type: 'expense',
  amount: 12.5,
  date: '2026-09-30',
  remark: 'A 的账'
})

const aPending = await adapterA.outbox.pendingCount()
const bPending = await adapterB.outbox.pendingCount()

t.ok('4a A 的队列里有自己刚记的那笔', aPending >= 1, `A pending=${aPending}`)
t.ok('4b ★ B 的队列完全看不到 A 的条目', bPending === 0, `B pending=${bPending}`)
const bBills = await adapterB.bill.list({ from: '2026-09-01', to: '2026-09-30' })
t.ok('4c A 的账单不会出现在 B 的库里', bBills.length === 0, JSON.stringify(bBills.map((b) => b.id)))
t.ok('4d A 自己读得到那笔', (await adapterA.bill.list({ from: '2026-09-01', to: '2026-09-30' })).length === 1, String(createdA?.id))

/* ---------------- 5. 旧库 → 分区库的继承 ---------------- */

t.group('5. 旧（未分区）库 → 分区库：首次进入时继承')

// 造一个「旧用户」：数据都在裸库里
const legacyName = nextDb('legacy')
const legacy = await openDB({ dbName: legacyName, version: DB_VERSION })
await putMany(legacy, STORES.LEDGER, [{ id: 'ledger_default', name: '老用户的账本', currency: 'CNY', updatedAt: 100 }])
await putMany(legacy, STORES.CATEGORY, [{ id: 'cat_x', name: '吃喝', type: 'expense', updatedAt: 100 }])
await putMany(legacy, STORES.BILL, [{ id: 'bill_old', amount: 66, date: '2026-08-01', updatedAt: 100 }])
await putMany(legacy, STORES.OUTBOX, [{ id: 'ob_old', collection: 'bill', docId: 'bill_old', synced: false, retry: 0, ts: 1 }])
await writeMeta(legacy, { [META_KEYS.SEED]: { extra: 1 }, [META_KEYS.IMPORTED]: 123 })

const targetName = nextDb('target')
const targetPromise = openDB({ dbName: targetName, version: DB_VERSION })

const res = await migratePartitionData(targetPromise, { sourceDbName: legacyName })
t.ok('5a 判定为已搬迁', res.migrated === true, JSON.stringify(res))
t.ok('5b 账单搬过来了', res.counts?.[STORES.BILL] === 1, JSON.stringify(res.counts))
t.ok('5c 分类搬过来了', res.counts?.[STORES.CATEGORY] === 1, JSON.stringify(res.counts))
t.ok('5d 账本搬过来了', res.counts?.[STORES.LEDGER] === 1, JSON.stringify(res.counts))
t.ok('5e ★ outbox 队列也继承（否则未推的改动会凭空消失）', res.counts?.[STORES.OUTBOX] === 1, JSON.stringify(res.counts))

const target = await targetPromise
const targetBills = await readAll(target, STORES.BILL)
const targetOutbox = await readAll(target, STORES.OUTBOX)
const targetMeta = await readMeta(target)

t.ok('5f 目标库里能看到旧账单', targetBills.length === 1 && targetBills[0].id === 'bill_old')
t.ok('5g 目标库里能看到旧队列', targetOutbox.length === 1 && targetOutbox[0].id === 'ob_old')
t.ok('5h 进度类 meta 一并继承', targetMeta[META_KEYS.IMPORTED] === 123 && Boolean(targetMeta[META_KEYS.SEED]))
t.ok('5i 写下迁移标记（记的是源库名）', targetMeta[META_KEYS.PARTITION_MIGRATED] === legacyName, String(targetMeta[META_KEYS.PARTITION_MIGRATED]))

/* ---------------- 6. 继承的幂等与「不覆盖」 ---------------- */

t.group('6. 继承保护：不重复搬、不覆盖已有数据')

const res2 = await migratePartitionData(targetPromise, { sourceDbName: legacyName })
t.ok('6a 第二次调用直接跳过（标记已存在）', res2.migrated === false && res2.reason === 'already-migrated', JSON.stringify(res2))
t.ok('6b 数据仍是一份（没被搬成两份）', (await readAll(target, STORES.BILL)).length === 1)

// 造一个新库 + 一个不同的旧库，验证「目标非空就不搬」
const legacy2Name = nextDb('legacy2')
const legacy2 = await openDB({ dbName: legacy2Name, version: DB_VERSION })
await putMany(legacy2, STORES.BILL, [{ id: 'bill_should_not_arrive', amount: 1, updatedAt: 1 }])

const occupiedName = nextDb('occupied')
const occupiedPromise = openDB({ dbName: occupiedName, version: DB_VERSION })
const occupied = await occupiedPromise
await putMany(occupied, STORES.BILL, [{ id: 'bill_user_wrote', amount: 99, updatedAt: 5 }])

const res3 = await migratePartitionData(occupiedPromise, { sourceDbName: legacy2Name })
const occupiedBills = await readAll(occupied, STORES.BILL)
const occupiedMeta = await readMeta(occupied)

t.ok('6c ★ 目标库非空时不搬（不静默回退用户数据）', res3.migrated === false && res3.reason === 'target-not-empty', JSON.stringify(res3))
t.ok('6d 用户自己写的账单没被动过', occupiedBills.length === 1 && occupiedBills[0].id === 'bill_user_wrote')
t.ok('6e 但也补上标记（免得每次启动都扫一遍）', occupiedMeta[META_KEYS.PARTITION_MIGRATED] === legacy2Name)

/* ---------------- 7. 适配器层：migrateFrom 开关 ---------------- */

t.group('7. createIdbAdapter({ migrateFrom })：分区库接入继承')

const legacy3Name = nextDb('legacy3')
const legacy3 = await openDB({ dbName: legacy3Name, version: DB_VERSION })
await putMany(legacy3, STORES.LEDGER, [{ id: 'ledger_default', name: '继承来的账本', currency: 'CNY', updatedAt: 7 }])
await putMany(legacy3, STORES.BILL, [
  { id: 'bill_inherit_1', ledgerId: 'ledger_default', categoryId: 'c', type: 'expense', amount: 10, date: '2026-07-01', updatedAt: 7 },
  { id: 'bill_inherit_2', ledgerId: 'ledger_default', categoryId: 'c', type: 'expense', amount: 20, date: '2026-07-02', updatedAt: 7 }
])

const partitionName = nextDb('partition')
const partitioned = createIdbAdapter({ dbName: partitionName, seed: true, migrateFrom: legacy3Name })
await partitioned.ready()

const inheritedBills = await partitioned.bill.list({ from: '2026-07-01', to: '2026-07-31' })
t.ok('7a 分区库继承了旧账单', inheritedBills.length === 2, JSON.stringify(inheritedBills.map((b) => b.id)))
t.ok('7b 账本也继承', (await partitioned.ledger.list())[0]?.name === '继承来的账本')
t.ok(
  '7c ★ 继承时不播种（否则种子会与旧数据叠成两套）',
  !inheritedBills.some((b) => String(b.id).startsWith('bill_seed_')),
  JSON.stringify(inheritedBills.map((b) => b.id))
)

// 反例：不传 migrateFrom 的普通库照常播种
const plainName = nextDb('plain')
const plain = createIdbAdapter({ dbName: plainName, seed: true })
await plain.ready()
const plainBills = await plain.bill.list({ from: '2026-09-01', to: '2026-09-30' })
t.ok('7d 不传 migrateFrom 时正常播种', plainBills.length > 0, `bills=${plainBills.length}`)

/* ---------------- 8. 继承不会误搬（未登录分区也安全） ---------------- */

t.group('8. 边界：目标本来就空 + 源不存在')

const emptyTargetName = nextDb('emptytarget')
const missingSourceName = nextDb('missingsource')
const emptyTargetPromise = openDB({ dbName: emptyTargetName, version: DB_VERSION })
const res4 = await migratePartitionData(emptyTargetPromise, { sourceDbName: missingSourceName })
const emptyTarget = await emptyTargetPromise
const emptyMeta = await readMeta(emptyTarget)

t.ok('8a 源库为空时不报错，且明确标记为「没东西可搬」', res4.reason === 'empty-source', JSON.stringify(res4))
t.ok('8b 没有数据搬过来', res4.migrated === false && (await readAll(emptyTarget, STORES.BILL)).length === 0)
t.ok('8c 仍写下标记，避免反复重试', emptyMeta[META_KEYS.PARTITION_MIGRATED] === missingSourceName)
t.ok(
  '8d ★ 空源必须能被播种逻辑识别出来（否则全新设备首启是空 App）',
  await (async () => {
    const a = createIdbAdapter({ dbName: nextDb('seeded'), seed: true, migrateFrom: missingSourceName, claimant: 'zzzzzzzz' })
    await a.ready()
    return (await a.bill.list({ from: '2026-09-01', to: '2026-09-30' })).length > 0
  })()
)

t.group('9. 继承不会自搬自（分区库不该把裸库当成自己的源）')

// 目标库名与源库名相同时，迁移应当变成一次「读自己写自己」的空操作
const selfName = nextDb('self')
const self = await openDB({ dbName: selfName, version: DB_VERSION })
await putMany(self, STORES.BILL, [{ id: 'bill_self', amount: 3, updatedAt: 1 }])
const res5 = await migratePartitionData(openDB({ dbName: selfName, version: DB_VERSION }), {
  sourceDbName: selfName,
  force: true
})
t.ok('9a 强制模式下也不会变成两份', (await readAll(self, STORES.BILL)).length === 1, String(res5.reason))

/* ---------------- 10. ★ 裸库只能被认领一次 ---------------- */

t.group('10. ★ 裸库只被一个账号认领：后来的账号不继承（防跨账号串号）')

// 一个「有数据的裸库」 = 设备上原有的未分区数据
const sharedName = nextDb('shared')
const shared = await openDB({ dbName: sharedName, version: DB_VERSION })
await putMany(shared, STORES.BILL, [
  { id: 'bill_owner', amount: 88, date: '2026-06-01', updatedAt: 1 }
])
await writeMeta(shared, { [META_KEYS.IMPORTED]: 1 })

// 账号 A 先来：认领并搬走
const acctAName = nextDb('acctA2')
const acctAPromise = openDB({ dbName: acctAName, version: DB_VERSION })
const resA = await migratePartitionData(acctAPromise, { sourceDbName: sharedName, claimant: 'hvfpnrlq' })
t.ok('10a A 继承了裸库', resA.migrated === true && resA.counts?.[STORES.BILL] === 1, JSON.stringify(resA))
t.ok('10b 裸库被记为 A 认领', (await readMeta(shared))[META_KEYS.PARTITION_CLAIMED] === 'hvfpnrlq')

// 账号 B 后来：应当空手进
const acctBName = nextDb('acctB2')
const acctBPromise = openDB({ dbName: acctBName, version: DB_VERSION })
const resB = await migratePartitionData(acctBPromise, { sourceDbName: sharedName, claimant: 'kqjv1dcp' })
const acctB = await acctBPromise
t.ok('10c ★ B 不继承（裸库已有主）', resB.migrated === false && resB.reason === 'claimed-by-other', JSON.stringify(resB))
t.ok('10d ★ B 的库里一笔都没有', (await readAll(acctB, STORES.BILL)).length === 0)
t.ok('10e B 认领者仍是 A（没被抢占）', (await readMeta(shared))[META_KEYS.PARTITION_CLAIMED] === 'hvfpnrlq')
t.ok(
  '10f B 记下「不继承」的结论（免得每次启动重算）',
  String((await readMeta(acctB))[META_KEYS.PARTITION_MIGRATED]).startsWith('declined:'),
  String((await readMeta(acctB))[META_KEYS.PARTITION_MIGRATED])
)

// A 再回来：认领者是自己，应当能继续（这里已搬完，标记命中 already-migrated）
const acctAPromise2 = openDB({ dbName: acctAName, version: DB_VERSION })
const resA2 = await migratePartitionData(acctAPromise2, { sourceDbName: sharedName, claimant: 'hvfpnrlq' })
t.ok('10g A 回来时不报错（自己认领的库）', resA2.reason === 'already-migrated', JSON.stringify(resA2))

// 不传 claimant（未分区/测试场景）时退回老行为：不检查认领
const noClaimName = nextDb('noclaim')
const noClaimPromise = openDB({ dbName: noClaimName, version: DB_VERSION })
const resNC = await migratePartitionData(noClaimPromise, { sourceDbName: sharedName })
t.ok('10h 不传 claimant 时不做认领检查（老行为）', resNC.migrated === true, JSON.stringify(resNC))

/* ---------------- 11. 认领随适配器装配生效 ---------------- */

t.group('11. createIdbAdapter({ migrateFrom, claimant })：认领接到适配器上')

const shared2Name = nextDb('shared2')
const shared2 = await openDB({ dbName: shared2Name, version: DB_VERSION })
await putMany(shared2, STORES.BILL, [{ id: 'bill_orig', amount: 5, date: '2026-06-02', updatedAt: 1 }])

const first = createIdbAdapter({ dbName: nextDb('first'), seed: true, migrateFrom: shared2Name, claimant: 'aaaaaaaa' })
await first.ready()
t.ok('11a 第一个账号继承到数据', (await first.bill.list({ from: '2026-06-01', to: '2026-06-30' })).length === 1)

const second = createIdbAdapter({ dbName: nextDb('second'), seed: true, migrateFrom: shared2Name, claimant: 'bbbbbbbb' })
await second.ready()
const secondBills = await second.bill.list({ from: '2026-06-01', to: '2026-06-30' })
t.ok('11b ★ 第二个账号既没继承、也没被播种（空库开始）', secondBills.length === 0, JSON.stringify(secondBills.map((b) => b.id)))

/* ---------------- 12. 未登录分区 ledger_guest（S7-2 + S7-9） ---------------- */

t.group('12. 未登录分区只播基础设施（没有演示账单）')

{
  // `'base'` 档 = 账本 + 分类，一条演示账单都没有
  const guest = createIdbAdapter({ dbName: nextDb('guest'), seed: 'base', migrateFrom: false })
  const snap = await guest.snapshot()
  t.eq('12a guest 分区有账本（ledgerStore.currentId 依赖它）', snap.ledgers.length, 1)
  t.eq('12b guest 分区的分类齐备（41 条，宫格不会是空的）', snap.categories.length, 41)
  t.eq('12c ★ guest 分区没有任何演示账单', snap.bills.length, 0)
  t.ok('12d guest 分区没写演示数据迁移标记', snap.meta.seedExtra === undefined)

  // `'full'` 档仍能播出演示数据 —— S7-9 补丁后它只留给开发构建的
  // 「重置演示数据」抬档用，任何分区的常规启动都不再走这一档
  const devGuest = createIdbAdapter({ dbName: nextDb('guestfull'), seed: 'full' })
  t.ok('12e \'full\' 档播出演示数据（保留给「重置演示数据」抬档）', (await devGuest.snapshot()).bills.length > 0)

  // 登录后的账号分区：只播基础设施，且兜底分类 updatedAt = 0
  const acct = createIdbAdapter({
    dbName: nextDb('account'),
    seed: 'base',
    seedCategoryUpdatedAt: 0
  })
  const acctSnap = await acct.snapshot()
  t.eq('12f ★ 账号分区同样没有演示账单（新账号不会凭空多 ¥8720.72）', acctSnap.bills.length, 0)
  t.eq('12g 账号分区的分类齐备', acctSnap.categories.length, 41)
  t.ok(
    '12h ★ 账号分区的兜底分类 updatedAt = 0（不会盖掉云端改过名字的分类）',
    acctSnap.categories.every((c) => c.updatedAt === 0)
  )

  // 再进来一次：`'base'` 档是幂等的，不会因为「没有 seedExtra 标记」把演示账单补进来
  await guest.ready()
  const snap2 = await guest.snapshot()
  t.eq('12i 二次加载仍是 0 条账单（base 档不跑演示数据迁移）', snap2.bills.length, 0)
  t.eq('12j 二次加载分类数不变', snap2.categories.length, 41)
}

/* ---------------- 13. 未登录分区的一次性清理（S7-9 补丁） ---------------- */

t.group('13. ★ purgeSeedBills：老 guest 库里的演示账单清一次')

{
  // 造一个「S7-9 补丁之前」的 guest 库：已被旧构建灌过整套演示账单
  const legacyGuest = nextDb('guestlegacy')
  const raw = await openDB({ dbName: legacyGuest, version: DB_VERSION })
  await putMany(raw, STORES.BILL, [
    { id: 'bill_demo_1', ledgerId: 'ledger_default', categoryId: null, type: 'income', amount: 12000, date: '2026-10-01', remark: '月薪', updatedAt: 1 },
    { id: 'bill_demo_2', ledgerId: 'ledger_default', categoryId: null, type: 'expense', amount: 45, date: '2026-10-01', remark: '地铁通勤', updatedAt: 1 }
  ])

  const g1 = createIdbAdapter({ dbName: legacyGuest, seed: 'base', purgeSeedBills: true })
  const snap1 = await g1.snapshot()
  t.eq('13a ★ 老 guest 库的演示账单在首次启动被整批清掉', snap1.bills.length, 0)
  // ⚠️ snapshot().meta 只含 seedMeta 子对象，顶层标记要用 readMeta 直读
  const meta1 = await readMeta(await openDB({ dbName: legacyGuest, version: DB_VERSION }))
  t.ok('13b 清理动作落了一次性标记', Boolean(meta1.seedBillsPurged))
  t.eq('13c 清理不碰基础设施（分类还在）', snap1.categories.length, 41)

  // 模拟「重置演示数据」之后的库：标记在、账单也在 ⇒ 二次启动**不清**
  const g2 = createIdbAdapter({ dbName: legacyGuest, seed: 'base', purgeSeedBills: true })
  await putMany(raw, STORES.BILL, [
    { id: 'bill_reset_1', ledgerId: 'ledger_default', categoryId: null, type: 'expense', amount: 66, date: '2026-10-02', remark: '重置灌进来的', updatedAt: 2 }
  ])
  const snap2 = await g2.snapshot()
  t.eq('13d ★ 标记已落 ⇒ 再次启动不再清（保住「重置演示数据」的成果）', snap2.bills.length, 1)

  // 对照组：不传 purgeSeedBills 的分区（账号分区）绝不能动用户的账单
  const acctDb = nextDb('acctnopurge')
  const acctRaw = await openDB({ dbName: acctDb, version: DB_VERSION })
  await putMany(acctRaw, STORES.BILL, [
    { id: 'bill_user_1', ledgerId: 'ledger_default', categoryId: null, type: 'expense', amount: 99, date: '2026-10-01', remark: '用户的真账', updatedAt: 1 }
  ])
  const acct = createIdbAdapter({ dbName: acctDb, seed: 'base' })
  const acctSnap = await acct.snapshot()
  t.eq('13e ★ 不传 purgeSeedBills 的分区一条账单都不动', acctSnap.bills.length, 1)
  const acctMeta = await readMeta(acctRaw)
  t.ok('13f 账号分区也没有清理标记', acctMeta.seedBillsPurged === undefined)
}

/* ---------------- 14. 连接层自愈（Chrome 单方面关连接的顽疾） ---------------- */

t.group('14. ★ createIdbConnection：连接被浏览器关掉后自动重连')

{
  // Chrome 会单方面关掉空闲连接（真机实测 2026-10-02：无痕窗口退出后重登录，
  // 登录链路全线抛「The database connection is closing」）。这里用注入的
  // 假 open 复现同一时序：第一根连接已死，acquire 必须能自愈到第二根。
  // 造一个与真机报错同形的错误（老 Node 没有 DOMException 时退回普通 Error）
  const makeClosedErr = () =>
    typeof DOMException === 'function'
      ? new DOMException(
          "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
          'InvalidStateError'
        )
      : Object.assign(new Error('The database connection is closing.'), { name: 'InvalidStateError' })
  const closedErr = makeClosedErr()

  const healthy = {
    transaction() {
      return { abort() {} }
    }
  }

  t.ok('14a isConnClosedError 认得 InvalidStateError', isConnClosedError(closedErr))
  t.ok('14b 也认得 message 匹配的普通 Error', isConnClosedError(new Error('The database connection is closing.')))
  t.ok('14c 别的错误不误伤', !isConnClosedError(new Error('boom')))

  // 14d：第一根连接已死 → 探活失败 → 自动重开 → 拿到第二根
  {
    let opens = 0
    const conn = createIdbConnection({
      dbName: 't_conn_dead',
      version: DB_VERSION,
      open() {
        opens++
        return Promise.resolve(opens === 1 ? { transaction() { throw closedErr } } : healthy)
      }
    })
    const db = await conn.acquire()
    t.ok('14d ★ 连接死了能自动重连', db === healthy && opens === 2)
  }

  // 14e：连接健康时不重开（探活通过直接复用）
  {
    let opens = 0
    const conn = createIdbConnection({
      dbName: 't_conn_alive',
      version: DB_VERSION,
      open() {
        opens++
        return Promise.resolve(healthy)
      }
    })
    const db1 = await conn.acquire()
    const db2 = await conn.acquire()
    t.ok('14e 健康连接被复用，不反复重开', db1 === db2 && opens === 1)
  }

  // 14f：打开失败的拒绝不能被缓存 —— 第一次失败，第二次要真正重开
  {
    let opens = 0
    const conn = createIdbConnection({
      dbName: 't_conn_reject',
      version: DB_VERSION,
      open() {
        opens++
        return opens === 1 ? Promise.reject(new Error('blocked')) : Promise.resolve(healthy)
      }
    })
    let firstErr = null
    await conn.acquire().catch((e) => { firstErr = e })
    t.ok('14f 首次打开失败如实抛出', firstErr && firstErr.message === 'blocked')
    const db = await conn.acquire()
    t.ok('14g ★ 失败后下一次 acquire 会重开（拒绝不被缓存）', db === healthy && opens === 2)
  }
}

/* ---------------- 15. ★ 装配层不再继承裸库（S7-10 堵死污染路径） ---------------- */

/**
 * 真机实测（2026-10-02）：账号分区从裸库 `ledger` 继承了遗留的**演示账单**
 * （44 条种子里的 30 条），`enqueueLocalForCloud()` 把它们整体入队，
 * 下一轮同步就推到了真实账号名下 —— 直接击穿 S7「全新账号 0 账单」。
 *
 * 这一条用**源码扫描**防回归：`migrateFrom` 被写回「按分区打开」的表达式时，
 * 所有单测照样全绿（适配器能力本身没被删），只有真机上才会看到
 * 「新账号凭空多出演示账」。扫描前先剥掉注释，避免被文档里的示例代码误伤。
 */
t.group('15. ★ api/index.js：装配层不给任何分区开 migrateFrom')

{
  const indexSrc = readFileSync(new URL('../src/api/index.js', import.meta.url), 'utf8')
  const code = indexSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

  /**
   * ⚠️ 不能用 `/migrateFrom:\s*(?!false)/` 判反例 —— `\s*` 会回溯到「零个空格」，
   *    让 `migrateFrom: false` 也被判成命中（实测误报）。改成**把值取出来看**。
   */
  const migrateValues = [...code.matchAll(/migrateFrom:\s*([^,\n}]*)/g)].map((m) => m[1].trim())

  t.ok('15a ★ 装配层确实传了 migrateFrom', migrateValues.length > 0, migrateValues.join(' | '))
  t.ok(
    '15b ★ 值只能是 false（没有任何「按分区条件」打开继承的写法）',
    migrateValues.length > 0 && migrateValues.every((v) => v === 'false'),
    migrateValues.join(' | ')
  )
  t.ok('15c 认领标识（claimant）随继承一起下线', !/claimant:/.test(code))
}

/* ---------------- 16. ★ 注销账号：本地分区清回出厂态（S8-4） ---------------- */

/**
 * 「注销账号」要求这个分区**回到从未使用过的状态**，而 `clearLocalData()`
 * （退出登录用）做不到这件事：它清表但**保留** `schemaVersion`，于是同一个
 * 手机号再登录时 `init()` 认为「这个库初始化过」而**跳过播种** ——
 * 用户看到一片空宫格（S7 真机踩过的同款症状）。
 *
 * ⚠️ 实现上**刻意不走 `indexedDB.deleteDatabase`**：还有别的连接（另一个标签页）
 *    开着时，删除请求会被永久挂起，而且此后连 `open()` 同一库都要排到它后面
 *    —— 「删不掉就退回去清表」的兜底会自己把自己锁死（fake-indexeddb 复现，
 *    与规范一致）。等价做法是「清空全部表 + 抹掉 meta + 清遗留 localStorage 键」，
 *    这一节同时钉住这三步，任何一步漏掉都会让同号回来时看到空宫格或旧数据复活。
 */
t.group('16. ★ deleteLocalData：注销把分区清回出厂态')

{
  /* ---- 16A：注销后「同号再登录」必须能重新播种 ---- */

  const delName = nextDb('delaccount')

  // 模拟「登录后用过一阵」的分区：基础设施 + 用户账单 + 待推队列
  const delAdapter = createIdbAdapter({ dbName: delName, seed: 'base', seedCategoryUpdatedAt: 0 })
  await delAdapter.ready()
  await delAdapter.bill.create({
    ledgerId: 'ledger_default',
    categoryId: null,
    type: 'expense',
    amount: 168,
    date: '2026-10-02',
    remark: '注销前的账'
  })
  const beforeSnap = await delAdapter.snapshot()
  t.ok('16a 注销前分区里确实有数据', beforeSnap.bills.length === 1 && beforeSnap.categories.length === 41)

  // 造一份「第一阶段遗留」的 localStorage 旧库与旧队列（S1 接管后**刻意不删**）
  localStorage.setItem(LEGACY_DB_KEY, JSON.stringify({ schemaVersion: 1, bills: [{ id: 'old' }] }))
  localStorage.setItem(LEGACY_OUTBOX_KEY, JSON.stringify([{ id: 'ob_old' }]))

  t.ok('16b 清理返回 true', (await delAdapter.deleteLocalData()) === true)
  t.ok('16c ★ 遗留 DB 键一并清掉（否则下次 init 会把旧库重新导入）', localStorage.getItem(LEGACY_DB_KEY) === null)
  t.ok('16d 遗留 outbox 键同理', localStorage.getItem(LEGACY_OUTBOX_KEY) === null)

  const clearedMeta = await readMeta(await openDB({ dbName: delName, version: DB_VERSION }))
  t.ok(
    '16e ★ 建库标记被抹掉（这是「能重新播种」的前提）',
    clearedMeta[META_KEYS.SCHEMA] === undefined,
    JSON.stringify(clearedMeta)
  )

  // 「同一个手机号再登录」= 同一个库名重新建适配器
  const reLogin = createIdbAdapter({ dbName: delName, seed: 'base', seedCategoryUpdatedAt: 0 })
  const snap = await reLogin.snapshot()
  t.eq('16f ★ 分区重新播种：分类恢复 41 条（不会是一片空宫格）', snap.categories.length, 41)
  t.eq('16g ★ 用户账单一条不剩', snap.bills.length, 0)
  t.eq('16h 账本回来了（App 起得来）', snap.ledgers.length, 1)
  t.eq('16i 待推队列也空了（不会把上个账号的改动推给新身份）', await reLogin.outbox.pendingCount(), 0)

  // 同一个实例自己也要能恢复（生产里 bucketCache 会把这个实例还回来）
  const selfSnap = await delAdapter.snapshot()
  t.eq('16j ★ 被清理过的那个实例自身也能重播种（initPromise 被作废）', selfSnap.categories.length, 41)

  /* ---- 16B：反例 —— clearLocalData() 不能拿来当注销 ---- */

  const clearName = nextDb('clearaccount')
  const clearAdapter = createIdbAdapter({ dbName: clearName, seed: 'base', seedCategoryUpdatedAt: 0 })
  await clearAdapter.ready()
  await clearAdapter.clearLocalData()

  const afterClear = createIdbAdapter({ dbName: clearName, seed: 'base', seedCategoryUpdatedAt: 0 })
  const clearSnap = await afterClear.snapshot()
  t.eq(
    '16k ★ 反例：clearLocalData 保留 schemaVersion ⇒ 同号回来**不播种**，分类是 0 条',
    clearSnap.categories.length,
    0
  )
  t.eq('16l 反例：库里也不剩账单（数据确实被清了，问题只在「回不来」）', clearSnap.bills.length, 0)
}

/* ---------------- 17. ★ 废弃字段清理 + month 死索引（S8-5） ---------------- */

/**
 * S8-5 从契约里删掉了三个**从写入到读取都没有消费者**的字段：
 *   账单 `noReimburse`（开关 S7-10 已下线 / 写入恒 false）、
 *   账单 `version`（早期设想的「服务端同步版本号」，从未被读取）、
 *   账本 `ownerId`（云端归属靠 `_openid`，本地靠库分区）。
 *
 * 删契约不等于删数据 —— 老设备的库里、老备份文件里都还留着这些键。这一节钉住
 * 两件事：**本地迁移真的把它们删干净了**，以及**删的时候没有惊动同步**。
 *
 * ⚠️ 「没有惊动同步」是这里的重点，也是最容易被写错的地方：抬 `updatedAt` 或
 *    入 outbox 都会让这条文档在下一轮同步里被判成「本地更新」而推上云 ——
 *    既去覆盖云端那份，又可能盖掉别的设备上的新修改。所以断言里专门验
 *    「时间戳原样」+「队列没有多出条目」。
 */
t.group('17. ★ S8-5：废弃字段清理与 month 死索引')

{
  /* ---- 17A：老库里的废弃字段，init 时被清掉 ---- */

  const purgeName = nextDb('purge')

  // 手工造一个「老版本写入过」的库：v3 结构 + 带废弃字段的文档 + 有 schemaVersion
  // （有它才会跳过播种，从而把这一节的变量控制到只剩「字段清理」一件事）
  const rawPurge = await openDB({ dbName: purgeName, version: DB_VERSION })
  await writeMeta(rawPurge, { [META_KEYS.SCHEMA]: SCHEMA_VERSION })
  await putMany(rawPurge, STORES.LEDGER, [
    { id: 'ledger_default', name: '默认账本', ownerId: 'user_local', createdAt: 1, updatedAt: 1 }
  ])
  await putMany(rawPurge, STORES.BILL, [
    {
      id: 'bill_old_1',
      ledgerId: 'ledger_default',
      type: 'expense',
      amount: 168,
      categoryId: 'cat_daily',
      primaryCategoryId: 'cat_daily',
      remark: '老版本写的账',
      date: '2026-10-02',
      noReimburse: true,
      version: 7,
      createdAt: 111,
      updatedAt: 222,
      deleted: 0
    }
  ])
  rawPurge.close()
  const metaBefore = await readMeta(await openDB({ dbName: purgeName, version: DB_VERSION }))
  t.ok('17a 造好的老库里确实带着废弃字段', metaBefore[META_KEYS.DEPRECATED_FIELDS_PURGED] === undefined)

  // 「下次启动」
  const purged = createIdbAdapter({ dbName: purgeName, seed: false })
  await purged.ready()

  const rawAfter = await openDB({ dbName: purgeName, version: DB_VERSION })
  const billsAfter = await readAll(rawAfter, STORES.BILL)
  const ledgersAfter = await readAll(rawAfter, STORES.LEDGER)
  const metaAfter = await readMeta(rawAfter)

  t.ok(
    '17b ★ 账单上的 noReimburse / version 被删掉',
    billsAfter.every((b) => !('noReimburse' in b) && !('version' in b)),
    JSON.stringify(billsAfter[0])
  )
  t.ok('17c ★ 账本上的 ownerId 被删掉', ledgersAfter.every((l) => !('ownerId' in l)))
  t.ok(
    '17d 该留的字段一个不少（remark / primaryCategoryId / deleted）',
    billsAfter[0].remark === '老版本写的账' &&
      billsAfter[0].primaryCategoryId === 'cat_daily' &&
      billsAfter[0].deleted === 0
  )
  t.eq(
    '17e ★★ updatedAt 原样不动（抬时间戳会让它被判成「本地更新」而推上云）',
    [billsAfter[0].createdAt, billsAfter[0].updatedAt],
    [111, 222]
  )
  t.eq('17f ★★ 没有多出待推条目（字段清理不走 outbox）', await purged.outbox.pendingCount(), 0)
  t.eq('17g meta 落了一次性标记', metaAfter[META_KEYS.DEPRECATED_FIELDS_PURGED], 1)

  // 幂等：再来一次不该有任何变化
  const purgedAgain = createIdbAdapter({ dbName: purgeName, seed: false })
  await purgedAgain.ready()
  const billsAgain = await readAll(await openDB({ dbName: purgeName, version: DB_VERSION }), STORES.BILL)
  t.eq('17h 再启动一次结果不变（幂等）', billsAgain[0], billsAfter[0])
  t.eq('17i 队列依然是空的', await purgedAgain.outbox.pendingCount(), 0)

  /* ---- 17B：month 死索引（建在从未写入的字段上） ---- */

  const freshIdx = await openDB({ dbName: nextDb('idxnew'), version: DB_VERSION })
  t.ok(
    '17j 新建的库不含 month 索引',
    !freshIdx.transaction(STORES.BILL, 'readonly').objectStore(STORES.BILL).indexNames.contains('month')
  )
  freshIdx.close()

  // 手工造一个 v2 结构的老库（带 month 索引），验证升级路径真的把它删掉
  const legacyIdxName = nextDb('idxlegacy')
  await new Promise((resolve, reject) => {
    const req = indexedDB.open(legacyIdxName, 2)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore(STORES.LEDGER, { keyPath: 'id' })
      const cat = db.createObjectStore(STORES.CATEGORY, { keyPath: 'id' })
      cat.createIndex('ledgerId', 'ledgerId')
      cat.createIndex('parentId', 'parentId')
      cat.createIndex('type', 'type')
      cat.createIndex('updatedAt', 'updatedAt')
      const bill = db.createObjectStore(STORES.BILL, { keyPath: 'id' })
      bill.createIndex('ledgerId', 'ledgerId')
      bill.createIndex('date', 'date')
      bill.createIndex('month', 'month') // ← 老库那份死索引
      bill.createIndex('categoryId', 'categoryId')
      bill.createIndex('updatedAt', 'updatedAt')
      db.createObjectStore(STORES.OUTBOX, { keyPath: 'id' }).createIndex('synced', 'synced')
      db.createObjectStore(STORES.META, { keyPath: 'key' })
    }
    req.onsuccess = () => {
      req.result.close()
      resolve()
    }
    req.onerror = () => reject(req.error)
  })

  const asV2 = await openDB({ dbName: legacyIdxName, version: 2 })
  t.ok(
    '17k 老库（v2）确实带 month 索引（否则这一组测了个寂寞）',
    asV2.transaction(STORES.BILL, 'readonly').objectStore(STORES.BILL).indexNames.contains('month')
  )
  await putMany(asV2, STORES.BILL, [{ id: 'b_keep', ledgerId: 'ledger_default', amount: 1, date: '2026-10-02' }])
  asV2.close()

  const asV3 = await openDB({ dbName: legacyIdxName, version: DB_VERSION })
  const billIdx = asV3.transaction(STORES.BILL, 'readonly').objectStore(STORES.BILL).indexNames
  t.ok('17l ★ 升级到 v3 后 month 索引被删掉', !billIdx.contains('month'))
  t.ok(
    '17m 其它索引原样保留',
    ['ledgerId', 'date', 'categoryId', 'updatedAt'].every((n) => billIdx.contains(n))
  )
  const keptRows = await readAll(asV3, STORES.BILL)
  t.eq('17n 升级不丢数据', keptRows.length, 1)
  asV3.close()
}

/* ---------------- 18. 废弃种子分类清理（S8-7） ---------------- */

{
  const { REMOVED_SEED_CATEGORY_IDS, buildSeed } = await import(`${SRC}api/mock/seed.js`)

  /** 从源码里抠出分类树的所有 key —— 顺带证明「种子里真的没有 goose 了」 */
  const seedSrc = readFileSync(new URL('../src/api/mock/seed.js', import.meta.url), 'utf8')
  const treeSrc = seedSrc.match(/const CATEGORY_TREE = \[[\s\S]*?\n\]/)[0]
  const TREE_KEYS = [...treeSrc.matchAll(/key: '([^']+)'/g)].map((m) => m[1])

  t.eq('18a ★ 废弃名单里就是那只鹅', REMOVED_SEED_CATEGORY_IDS, ['cat_goose'])
  t.ok('18b ★ 种子树里已经没有 goose 了', !TREE_KEYS.includes('goose'))

  /* ---- 18A：老库（播种过含鹅版本的库）里的残留被清掉 ---- */
  const gooseDb = nextDb('goose')

  // 手工造「老版本播种过」的库：41 条正常分类之外，多一条 cat_goose，
  // 外加一条挂在它下面的二级分类（种子里没有，但要保证清理不留孤儿）
  const rawGoose = await openDB({ dbName: gooseDb, version: DB_VERSION })
  await writeMeta(rawGoose, { [META_KEYS.SCHEMA]: SCHEMA_VERSION })
  const seedNow = buildSeed(1, { mode: 'base' })
  await putMany(rawGoose, STORES.CATEGORY, [
    ...seedNow.categories,
    { id: 'cat_goose', name: '卤鹅', icon: 'duck', parentId: null, type: 'expense', ledgerId: 'ledger_default', order: 16, createdAt: 1, updatedAt: 1, deleted: 0 },
    { id: 'sub_goose-leg', name: '鹅腿', icon: 'duck', parentId: 'cat_goose', type: 'expense', ledgerId: 'ledger_default', order: 0, createdAt: 1, updatedAt: 1, deleted: 0 },
    // 用户自建的「卤鹅」：名字一样，但 id 是随机的 —— 绝不能被误删
    { id: 'cat_mine_goose', name: '卤鹅', icon: 'duck', parentId: null, type: 'expense', ledgerId: 'ledger_default', order: 17, createdAt: 9, updatedAt: 9, deleted: 0 }
  ])
  // 一笔挂在鹅下面的账（历史数据里真有可能存在）
  await putMany(rawGoose, STORES.BILL, [
    {
      id: 'bill_goose_1',
      ledgerId: 'ledger_default',
      type: 'expense',
      amount: 66,
      categoryId: 'cat_goose',
      primaryCategoryId: 'cat_goose',
      remark: '吃鹅',
      date: '2026-09-20',
      createdAt: 5,
      updatedAt: 6,
      deleted: 0
    }
  ])
  rawGoose.close()

  const before = await readAll(await openDB({ dbName: gooseDb, version: DB_VERSION }), STORES.CATEGORY)
  t.eq('18c 造好的老库里确实有那只鹅（否则这一组测了个寂寞）', before.length, 41 + 3)

  const gooseAdapter = createIdbAdapter({ dbName: gooseDb, seed: false })
  await gooseAdapter.ready()

  const dbAfter = await openDB({ dbName: gooseDb, version: DB_VERSION })
  const catsAfter = await readAll(dbAfter, STORES.CATEGORY)
  const idsAfter = catsAfter.map((c) => c.id)

  t.ok('18d ★ cat_goose 被删掉了', !idsAfter.includes('cat_goose'))
  t.ok('18e ★ 挂在它下面的二级分类一并清掉（不留孤儿）', !idsAfter.includes('sub_goose-leg'))
  t.eq('18f ★ 只少了那两条（41 条种子 + 1 条用户自建 = 42）', catsAfter.length, 42)
  t.ok(
    '18g ★★ 用户自建的「卤鹅」（随机 id）安然无恙 —— 名单只认固定 id，不按名字匹配',
    idsAfter.includes('cat_mine_goose')
  )
  t.ok('18h 其它分类一条不少', seedNow.categories.every((c) => idsAfter.includes(c.id)))

  // 挂在这只鹅下面的账：分类没了，账必须还在（显示「未分类」，不能连账一起删）
  const gooseBills = await readAll(dbAfter, STORES.BILL)
  t.eq('18i ★ 账不会被连坐删除', gooseBills.length, 1)
  const decorated = await gooseAdapter.bill.get('bill_goose_1')
  t.eq('18j ★ 它显示为「未分类」（分类缺失时的兜底，不是崩掉）', decorated.displayName, '未分类')
  t.eq(
    '18k 账上的 categoryId 原样留着（改它等于替用户改内容）',
    [decorated.categoryId, decorated.updatedAt],
    ['cat_goose', 6]
  )

  t.eq('18l ★★ 清理不入队列（入队会被判成「本地更新」而推上去顶掉别的设备）', await gooseAdapter.outbox.pendingCount(), 0)

  /* ---- 18B：每次都跑 ⇒ 云端残留被回拉回来也能自愈 ---- */
  await putMany(await openDB({ dbName: gooseDb, version: DB_VERSION }), STORES.CATEGORY, [
    { id: 'cat_goose', name: '卤鹅', icon: 'duck', parentId: null, type: 'expense', ledgerId: 'ledger_default', order: 16, createdAt: 1, updatedAt: 999999, deleted: 0 }
  ])

  const gooseAgain = createIdbAdapter({ dbName: gooseDb, seed: false })
  await gooseAgain.ready()
  const catsAgain = await readAll(await openDB({ dbName: gooseDb, version: DB_VERSION }), STORES.CATEGORY)
  t.ok('18m ★★ 被回拉回来的那只鹅，下次启动又被清掉（不变式，不靠一次性标记）', !catsAgain.map((c) => c.id).includes('cat_goose'))
  t.eq('18n 反复启动结果稳定', catsAgain.length, 42)
  t.eq('18o 队列始终干净', await gooseAgain.outbox.pendingCount(), 0)
}

/* ==========================================================================
 * 第 19 节（S8-8）：种子分类图标换新（CATEGORY_ICON_REFRESH 不变式）
 * ========================================================================== */
{
  const { buildSeed, CATEGORY_ICON_REFRESH } = await import(`${SRC}api/mock/seed.js`)

  t.eq('19a ★ 换新名单就一条：奶茶 lollipop → bubbleTea', CATEGORY_ICON_REFRESH, [
    { id: 'sub_snack-milktea', from: 'lollipop', to: 'bubbleTea' }
  ])

  const iconDb = nextDb('icon')
  const rawIcon = await openDB({ dbName: iconDb, version: DB_VERSION })
  await writeMeta(rawIcon, { [META_KEYS.SCHEMA]: SCHEMA_VERSION })
  const seedBase = buildSeed(1, { mode: 'base' })
  await putMany(rawIcon, STORES.CATEGORY, seedBase.categories)
  rawIcon.close()

  const iconAdapter = createIdbAdapter({ dbName: iconDb, seed: false })
  await iconAdapter.ready()

  const cats = await readAll(await openDB({ dbName: iconDb, version: DB_VERSION }), STORES.CATEGORY)
  const milktea = cats.find((c) => c.id === 'sub_snack-milktea')
  t.eq('19b ★ 已播种过的库里，奶茶的图标被刷成 bubbleTea', milktea?.icon, 'bubbleTea')
  t.ok(
    '19c ★ 其它分类的图标一个都没动（名单外零波及）',
    cats.filter((c) => c.id !== 'sub_snack-milktea' && !seedBase.categories.find((s) => s.id === c.id && s.icon === c.icon)).length === 0
  )
  t.eq('19d 刷新不动 updatedAt（视觉刷新不是数据变更）', milktea?.updatedAt, seedBase.categories.find((c) => c.id === 'sub_snack-milktea').updatedAt)
  t.eq('19e 队列干净（不入 outbox）', await iconAdapter.outbox.pendingCount(), 0)

  /* ---- 19B：守卫生效 —— 用户自己改过图标的分类不被覆盖 ---- */
  const appleDoc = cats.find((c) => c.id === 'sub_snack-fruit')
  await putMany(await openDB({ dbName: iconDb, version: DB_VERSION }), STORES.CATEGORY, [
    { ...appleDoc, icon: 'diamond' } // 用户把「水果」的图标改成了钻石
  ])
  const againAdapter = createIdbAdapter({ dbName: iconDb, seed: false })
  await againAdapter.ready()
  const catsAgain = await readAll(await openDB({ dbName: iconDb, version: DB_VERSION }), STORES.CATEGORY)
  t.ok(
    '19f ★★ 用户改过的图标（diamond）原样保留 —— 守卫是「=== from 才动」',
    catsAgain.find((c) => c.id === 'sub_snack-fruit')?.icon === 'diamond'
  )
}

t.done()
