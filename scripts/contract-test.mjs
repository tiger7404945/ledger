/**
 * 契约一致性测试：同一套断言分别跑 mockAdapter 与 idbAdapter
 * 运行：npm run test:data
 *
 * 本脚本顺带验证一条关键路径：
 *   mockAdapter 先把种子写进 localStorage（模拟第一阶段的老用户），
 *   idbAdapter 首次打开时应当**接管**这份数据 —— 两个适配器的快照
 *   必须逐字段（含时间戳）完全一致。这也是「切数据源用户无感」的核心保证。
 *
 * IndexedDB 在 Node 里没有实现，用 fake-indexeddb 打桩。
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

const { createMockAdapter } = await import(`${SRC}api/adapters/mockAdapter.js`)
const { createIdbAdapter } = await import(`${SRC}api/adapters/idbAdapter.js`)
const date = await import(`${SRC}utils/date.js`)

const LEDGER_ID = 'ledger_default'

let pass = 0
let fail = 0
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass += 1
  else fail += 1
  console.log(
    `${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n    期望 ${JSON.stringify(want)}\n    实得 ${JSON.stringify(got)}`}`
  )
}
function ok(label, cond, extra = '') {
  if (cond) pass += 1
  else fail += 1
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : `  ${extra}`}`)
}

const codeOf = async (fn) => {
  try {
    await fn()
    return 'NO_ERROR'
  } catch (e) {
    return e.code || e.name
  }
}

/**
 * 存储快照的顺序归一化。
 * 注意：原始存储的返回顺序**不是契约的一部分** —— 内存数组是插入序，
 * IndexedDB 的 getAll 是主键序。这里按 id 排序后再比对内容。
 */
const byId = (arr) => [...arr].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/* ---------------------------------------------------------- */
/* 只读探针：把「同一个查询在两个适配器上的输出」全部收集起来做深比较 */
/* ---------------------------------------------------------- */
async function readProbe(adapter) {
  await adapter.ready?.()
  const { ledger, category, bill } = adapter
  const month = date.currentMonthKey()
  const year = Number(month.slice(0, 4))
  const snap = await adapter.snapshot()

  const monthBills = await bill.list({ ledgerId: LEDGER_ID, month })
  const cats = await category.list({ ledgerId: LEDGER_ID })
  const grouped = await bill.listGrouped({ ledgerId: LEDGER_ID, month })

  return {
    // 原始存储快照（含时间戳）：接管路径下应当完全一致（顺序归一化后比对）
    ledgers: byId(snap.ledgers),
    categories: byId(snap.categories),
    bills: byId(snap.bills),
    seedMeta: snap.meta,

    // 账本
    ledgerIds: (await ledger.list()).map((l) => l.id),
    ledgerName: (await ledger.get(LEDGER_ID))?.name,
    ledgerMissing: await ledger.get('nope'),

    // 分类
    catCount: cats.length,
    catNames: cats.map((c) => c.name),
    catOrders: cats.map((c) => c.order),
    trafficSubs: (await category.listChildren('cat_traffic')).map((c) => c.name),
    incomeCats: (await category.list({ ledgerId: LEDGER_ID, type: 'income' })).map((c) => c.name),

    // 账单列表与派生字段
    monthCount: monthBills.length,
    monthList: monthBills.map((b) => [
      b.id,
      b.displayName,
      b.categoryName,
      b.primaryCategoryName,
      b.categoryIcon,
      b.amount
    ]),
    incomeCount: (await bill.list({ ledgerId: LEDGER_ID, type: 'income' })).length,
    byCategory: (await bill.list({ ledgerId: LEDGER_ID, categoryId: 'cat_food' })).length,
    byDate: (await bill.list({ ledgerId: LEDGER_ID, date: monthBills[0].date })).length,
    ascTop: (await bill.list({ ledgerId: LEDGER_ID, order: 'asc' })).slice(0, 4).map((b) => b.id),
    recentTop: (await bill.recent({ ledgerId: LEDGER_ID })).slice(0, 4).map((b) => b.id),
    kwTraffic: (await bill.list({ ledgerId: LEDGER_ID, keyword: '交通' })).map((b) => b.id),
    kwRemark: (await bill.list({ ledgerId: LEDGER_ID, keyword: '食堂' })).map((b) => b.id),
    kwAmount: (await bill.list({ ledgerId: LEDGER_ID, keyword: '12000' })).length,

    // 区间与汇总
    monthSummary: await bill.summary({ ledgerId: LEDGER_ID, month }),
    yearSummary: await bill.summary({
      ledgerId: LEDGER_ID,
      from: date.yearFirstKey(year),
      to: date.yearLastKey(year)
    }),
    emptySummary: await bill.summary({ ledgerId: LEDGER_ID, from: '2019-01-01', to: '2019-12-31' }),

    // 分组 / 日历 / 备注候选
    grouped: grouped.map((g) => [g.date, g.income, g.expense, g.items.length]),
    daily: (await bill.dailySummary({ ledgerId: LEDGER_ID, month })).map((d) => [
      d.date,
      d.income,
      d.expense,
      d.count
    ]),
    remarkTraffic: await bill.remarkHistory({ ledgerId: LEDGER_ID, categoryId: 'cat_traffic' }),
    remarkFood: await bill.remarkHistory({ ledgerId: LEDGER_ID, categoryId: 'cat_food' }),
    remarkMissing: await bill.remarkHistory({ ledgerId: LEDGER_ID, categoryId: 'nope' }),
    detailOne: await bill.get(monthBills[0].id),
    detailMissing: await bill.get('nope')
  }
}

/* ---------------------------------------------------------- */
/* 写入探针：CRUD、错误码、软删除、级联删除 */
/* ---------------------------------------------------------- */
async function writeProbe(adapter) {
  await adapter.ready?.()
  const { ledger, category, bill } = adapter
  const month = date.currentMonthKey()
  const out = {}

  /* --- 校验错误码 --- */
  out.errEmptyName = await codeOf(() =>
    category.create({ name: '   ', type: 'expense', ledgerId: LEDGER_ID })
  )
  out.errLongName = await codeOf(() =>
    category.create({ name: '一二三四五六七八九', type: 'expense', ledgerId: LEDGER_ID })
  )
  out.errDupName = await codeOf(() =>
    category.create({ name: '餐饮', type: 'expense', ledgerId: LEDGER_ID })
  )
  out.errParentMissing = await codeOf(() =>
    category.create({ name: '孤儿', type: 'expense', ledgerId: LEDGER_ID, parentId: 'nope' })
  )
  out.errAmountZero = await codeOf(() => bill.create({ ledgerId: LEDGER_ID, amount: 0 }))
  out.errAmountNeg = await codeOf(() => bill.create({ ledgerId: LEDGER_ID, amount: -5 }))
  out.errCatNotFound = await codeOf(() => category.update('missing', { name: 'x' }))
  out.errBillNotFound = await codeOf(() => bill.update('missing', { amount: 1 }))
  out.errCatRemoveMissing = await codeOf(() => category.remove('missing'))
  out.errBillRemoveMissing = await codeOf(() => bill.remove('missing'))
  out.errLedgerNotFound = await codeOf(() => ledger.update('missing', { name: 'x' }))

  /* --- 分类 CRUD --- */
  const cat = await category.create({
    name: '契约类目',
    icon: 'more',
    type: 'expense',
    ledgerId: LEDGER_ID
  })
  out.catCreated = { name: cat.name, icon: cat.icon, order: cat.order, parentId: cat.parentId, deleted: cat.deleted }
  out.catDupAfter = await codeOf(() =>
    category.create({ name: '契约类目', type: 'expense', ledgerId: LEDGER_ID })
  )
  out.catOrderNext = (
    await category.create({ name: '契约类目二', icon: 'more', type: 'expense', ledgerId: LEDGER_ID })
  ).order
  out.catRenamed = (await category.update(cat.id, { name: '契约类目改' })).name
  out.catRenameDup = await codeOf(() => category.update(cat.id, { name: '契约类目二' }))
  out.catListed = (await category.list({ ledgerId: LEDGER_ID })).some((c) => c.id === cat.id)

  const sub = await category.create({
    name: '子类',
    icon: 'more',
    type: 'expense',
    ledgerId: LEDGER_ID,
    parentId: cat.id
  })
  out.subCreated = { parentIsCat: sub.parentId === cat.id, order: sub.order }
  out.subChildren = (await category.listChildren(cat.id)).map((c) => c.name)

  await category.remove(cat.id)
  const snapAfterCascade = await adapter.snapshot()
  out.cascade = {
    parentGet: await category.get(cat.id),
    parentInList: (await category.list({ ledgerId: LEDGER_ID })).some((c) => c.id === cat.id),
    parentRawDeleted: snapAfterCascade.categories.find((c) => c.id === cat.id)?.deleted,
    childGet: await category.get(sub.id),
    childRawDeleted: snapAfterCascade.categories.find((c) => c.id === sub.id)?.deleted,
    remainingChildren: (await category.listChildren(cat.id)).length
  }

  /* --- 账单 CRUD --- */
  const b = await bill.create({
    ledgerId: LEDGER_ID,
    type: 'expense',
    amount: 12.345,
    categoryId: 'cat_food',
    remark: '  备注带空格  ',
    date: date.todayKey()
  })
  out.billCreated = {
    amount: b.amount,
    remark: b.remark,
    displayName: b.displayName,
    categoryId: b.categoryId,
    primaryCategoryId: b.primaryCategoryId,
    type: b.type,
    deleted: b.deleted,
    version: b.version,
    noReimburse: b.noReimburse,
    date: b.date
  }
  out.countAfterCreate = (await bill.list({ ledgerId: LEDGER_ID, month })).length

  // 改到二级分类：primaryCategoryId 应联动到父级
  const sub2 = (await category.listChildren('cat_traffic'))[0]
  const b2 = await bill.update(b.id, { amount: 99.905, categoryId: sub2.id })
  out.billMovedToSub = {
    amount: b2.amount,
    displayName: b2.displayName,
    categoryId: b2.categoryId,
    primaryCategoryId: b2.primaryCategoryId,
    version: b2.version
  }
  out.remarkHistoryOfSub = await bill.remarkHistory({ ledgerId: LEDGER_ID, categoryId: sub2.id })

  // 改回一级分类
  const b3 = await bill.update(b.id, { categoryId: 'cat_food' })
  out.billBackToPrimary = { displayName: b3.displayName, primaryCategoryId: b3.primaryCategoryId }

  // categoryId 置空：保留原 primaryCategoryId（与第一阶段行为一致）
  const b4 = await bill.update(b.id, { categoryId: null })
  out.billNoCategory = {
    categoryId: b4.categoryId,
    displayName: b4.displayName,
    primaryCategoryId: b4.primaryCategoryId
  }

  // 改金额非法
  out.errUpdateAmount = await codeOf(() => bill.update(b.id, { amount: -1 }))

  await bill.remove(b.id)
  const snapAfterDelete = await adapter.snapshot()
  out.afterDelete = {
    get: await bill.get(b.id),
    inList: (await bill.list({ ledgerId: LEDGER_ID })).some((x) => x.id === b.id),
    rawDeleted: snapAfterDelete.bills.find((x) => x.id === b.id)?.deleted
  }
  out.countAfterDelete = (await bill.list({ ledgerId: LEDGER_ID, month })).length

  /* --- 账本 --- */
  out.ledgerRenamed = (await ledger.update(LEDGER_ID, { name: '改过的账本' })).name
  out.ledgerNameAfter = (await ledger.get(LEDGER_ID))?.name

  return out
}

/* ---------------------------------------------------------- */

console.log('== 阶段 1：mockAdapter 播种（模拟第一阶段老用户） ==')
const mock = createMockAdapter({ latency: 0 })
const mockRead = await readProbe(mock)
ok('mock 已播种账单', mockRead.bills.length > 40, `实得 ${mockRead.bills.length}`)
ok('mock 已把库写进 localStorage', store.has('ledger.db.v1'))

console.log('\n== 阶段 2：idbAdapter 首次打开应接管旧库，只读结果须与 mock 完全一致 ==')
const idb = createIdbAdapter({ dbName: 'ledger_contract_test' })
const idbRead = await readProbe(idb)

const rawMeta = await idb.snapshot()
ok('idb 确实接管了 localStorage 的旧库（时间戳一致即可证明）', idbRead.bills[0]?.id === mockRead.bills[0]?.id)

for (const key of Object.keys(mockRead)) {
  eq(`[只读] ${key}`, idbRead[key], mockRead[key])
}

console.log('\n== 阶段 3：写入探针，两个适配器结果须一致 ==')
const mockWrite = await writeProbe(mock)
const idbWrite = await writeProbe(idb)

for (const key of Object.keys(mockWrite)) {
  eq(`[写入] ${key}`, idbWrite[key], mockWrite[key])
}

console.log('\n== 阶段 4：契约完备性 ==')
for (const [name, adapter] of [
  ['mock', mock],
  ['idb', idb]
]) {
  const has = (obj, keys) => keys.every((k) => typeof obj[k] === 'function')
  ok(
    `${name}.ledger 方法齐全`,
    has(adapter.ledger, ['list', 'get', 'update'])
  )
  ok(
    `${name}.category 方法齐全`,
    has(adapter.category, ['list', 'get', 'create', 'update', 'remove', 'listChildren', 'reorder'])
  )
  ok(
    `${name}.bill 方法齐全`,
    has(adapter.bill, [
      'list',
      'listGrouped',
      'get',
      'create',
      'update',
      'remove',
      'summary',
      'dailySummary',
      'recent',
      'remarkHistory'
    ])
  )
  ok(`${name}.sync 方法齐全`, has(adapter.sync, ['pendingCount']))
  // 同步引擎的接缝：适配器把队列与本地读写口暴露出去，引擎才不用认识适配器
  ok(
    `${name} 暴露了 outbox / syncStore（同步引擎的接缝）`,
    !!adapter.outbox &&
      has(adapter.outbox, [
        'enqueue',
        'enqueueMany',
        'pending',
        'markSynced',
        'bumpRetry',
        'compact',
        'onChange'
      ])
  )
  ok(`${name}.syncStore 方法齐全`, has(adapter.syncStore, ['get', 'all', 'applyRemote']))
  ok(`${name} 有 reset / snapshot`, has(adapter, ['reset', 'snapshot']))
  ok(`${name}.name 为 ${name === 'mock' ? 'mock' : 'idb'}`, adapter.name === (name === 'mock' ? 'mock' : 'idb'))
}

// 写入后 idb 的数据确实落在 IndexedDB（而不是内存里）
const idbSnap = await idb.snapshot()
ok('idb 的写入已落库（账本名已持久化）', idbSnap.ledgers[0].name === '改过的账本')
ok('idb 的软删除已落库', idbSnap.bills.some((b) => b.deleted === 1))

// reset 后回到干净种子
await idb.reset()
const afterReset = await idb.snapshot()
ok('idb.reset 后账单数回到种子量', afterReset.bills.length === 44, `实得 ${afterReset.bills.length}`)
ok('idb.reset 后账本名回到默认', afterReset.ledgers[0].name === '默认账本')
ok(
  'idb.reset 后不含测试期间新增的分类（证明没有重新导入被写脏的旧库）',
  !afterReset.categories.some((c) => c.name.startsWith('契约类目'))
)

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
