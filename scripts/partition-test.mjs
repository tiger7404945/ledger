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
  META_KEYS,
  STORES,
  isPartitionedDbName,
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

/* 断言与汇总统一走 scripts/_harness.mjs（输出格式见该文件顶部说明） */
import { createSuite } from './_harness.mjs'

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
  t.eq('12b guest 分区的分类齐备（42 条，宫格不会是空的）', snap.categories.length, 42)
  t.eq('12c ★ guest 分区没有任何演示账单', snap.bills.length, 0)
  t.ok('12d guest 分区没写演示数据迁移标记', snap.meta.seedExtra === undefined)

  // 开发构建下的未登录分区用 `'full'` 档（对着设计稿看页面方便）
  const devGuest = createIdbAdapter({ dbName: nextDb('guestfull'), seed: 'full' })
  t.ok('12e 开发构建的 guest 分区能看到演示数据', (await devGuest.snapshot()).bills.length > 0)

  // 登录后的账号分区：只播基础设施，且兜底分类 updatedAt = 0
  const acct = createIdbAdapter({
    dbName: nextDb('account'),
    seed: 'base',
    seedCategoryUpdatedAt: 0
  })
  const acctSnap = await acct.snapshot()
  t.eq('12f ★ 账号分区同样没有演示账单（新账号不会凭空多 ¥8720.72）', acctSnap.bills.length, 0)
  t.eq('12g 账号分区的分类齐备', acctSnap.categories.length, 42)
  t.ok(
    '12h ★ 账号分区的兜底分类 updatedAt = 0（不会盖掉云端改过名字的分类）',
    acctSnap.categories.every((c) => c.updatedAt === 0)
  )

  // 再进来一次：`'base'` 档是幂等的，不会因为「没有 seedExtra 标记」把演示账单补进来
  await guest.ready()
  const snap2 = await guest.snapshot()
  t.eq('12i 二次加载仍是 0 条账单（base 档不跑演示数据迁移）', snap2.bills.length, 0)
  t.eq('12j 二次加载分类数不变', snap2.categories.length, 42)
}

t.done()
