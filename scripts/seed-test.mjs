/**
 * 种子数据与迁移的断言
 * 运行：node scripts/seed-test.mjs
 *
 * 覆盖三件事：
 * 1. 新种子：本月支出仍是设计稿的 8720.72，补充的收入/往月账单金额对得上
 * 2. **种子分层（S7-9）**：`buildBase()` 只含账本 + 分类、`buildDemoBills()`
 *    只含演示账单，生产构建下演示账单为空
 * 3. 迁移：早期本地库（没有 seedExtra 标记）加载时会补上补充账单，且
 *    幂等、不覆盖已有记录、不动用户自己的账
 */
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
}
globalThis.window = globalThis

const SRC = new URL('../src/', import.meta.url).href
const { createMockAdapter } = await import(`${SRC}api/adapters/mockAdapter.js`)
const seedMod = await import(`${SRC}api/mock/seed.js`)
const { buildSeed, buildBase, buildDemoBills, SEED_EXTRA_VERSION, SEED_MODE } = seedMod
const { SCHEMA_VERSION } = await import(`${SRC}api/contract.js`)
const date = await import(`${SRC}utils/date.js`)

const PERSIST_KEY = 'ledger.db.v1'
const ledgerId = 'ledger_default'

/* 断言与汇总统一走 scripts/_harness.mjs（输出格式见该文件顶部说明） */
import { createSuite } from './_harness.mjs'

const t = createSuite('seed-test')
const fresh = () => createMockAdapter({ latency: 0 })

const month = date.currentMonthKey()
const year = Number(month.slice(0, 4))

/* ---------------- 1. 新种子 ---------------- */

{
  const seed = buildSeed()
  const inMonth = seed.bills.filter((b) => date.monthKeyOf(b.date) === month)
  const expense = inMonth
    .filter((b) => b.type === 'expense')
    .reduce((s, b) => s + b.amount, 0)
  const income = inMonth
    .filter((b) => b.type === 'income')
    .reduce((s, b) => s + b.amount, 0)

  t.eq('本月支出 = 设计稿的 8720.72', Math.round(expense * 100) / 100, 8720.72)
  t.eq('本月收入 = 补充收入合计', Math.round(income * 100) / 100, 13768.5)
  t.ok('本月收入账单条数为 4', inMonth.filter((b) => b.type === 'income').length === 4)
  t.ok(
    '本月账单日期都不晚于今天',
    inMonth.every((b) => b.date <= date.todayKey()),
    inMonth.map((b) => b.date).join(',')
  )
  t.ok(
    '补充账单 id 唯一',
    new Set(seed.bills.map((b) => b.id)).size === seed.bills.length
  )
  t.eq('播种后 meta.seedExtra 已标记', seed.meta.seedExtra, SEED_EXTRA_VERSION)

  const pastMonths = new Set(
    seed.bills.filter((b) => date.monthKeyOf(b.date) !== month).map((b) => date.monthKeyOf(b.date))
  )
  t.ok('往月也有账单（按年趋势才有多个点）', pastMonths.size >= 2, `实得 ${[...pastMonths].join(',')}`)
}

/* ---------------- 1b. 种子分层（S7-9） ---------------- */

{
  const base = buildBase()
  t.eq('1b-1 buildBase 只含 1 个账本', base.ledgers.length, 1)
  t.eq('1b-2 buildBase 含 42 条分类（基础设施齐备）', base.categories.length, 42)
  t.ok('1b-3 buildBase 压根没有 bills 字段（不是空数组）', base.bills === undefined)

  const demo = buildDemoBills()
  t.ok('1b-4 buildDemoBills 在开发构建下非空', demo.length > 0, `实得 ${demo.length} 条`)
  t.ok('1b-5 演示账单都带 ledgerId（不是裸数据）', demo.every((b) => b.id && b.ledgerId))

  // 账号分区的兜底分类：`updatedAt = 0`，语义是「默认值，优先级最低」
  const zeroed = buildBase(1700000000000, { categoryUpdatedAt: 0 })
  t.ok(
    '1b-6 账号分区兜底分类的 updatedAt = 0（云端改过名的分类不会被盖回来）',
    zeroed.categories.every((c) => c.updatedAt === 0)
  )
  t.eq('1b-7 账本本身仍用真实时间戳', zeroed.ledgers[0].updatedAt, 1700000000000)
  const normal = buildBase(1700000000000)
  t.eq('1b-8 不传 categoryUpdatedAt 时分类用播种时间', normal.categories[0].updatedAt, 1700000000000)

  // 两档组合
  const full = buildSeed(1700000000000, { mode: SEED_MODE.FULL })
  const onlyBase = buildSeed(1700000000000, { mode: SEED_MODE.BASE })
  t.ok('1b-9 full 档 = 基础设施 + 演示账单', full.bills.length > 0 && full.categories.length === 42)
  t.eq('1b-10 base 档不含任何演示账单', onlyBase.bills.length, 0)
  t.eq('1b-11 base 档的分类仍然齐备', onlyBase.categories.length, full.categories.length)
  t.ok(
    '1b-12 base 档不写演示数据迁移标记（没播就没得迁移）',
    onlyBase.meta.seedExtra === undefined && onlyBase.meta.seedNotes === undefined
  )
  t.eq('1b-13 演示数据没缩水（仍是 44 条）', full.bills.length, 44)

  /**
   * 生产构建：**再求值一次同一个模块**（URL 加 query 破坏 ESM 缓存），
   * 但把 `NODE_ENV` 临时设成 `production`。
   *
   * 为什么这样够用：Vite 构建时会把 `import.meta.env.DEV` 静态替换成 `false`；
   * Node 里没有 `import.meta.env`，`mock/seed.js` 用 `NODE_ENV` 模拟同一个分支。
   * 于是「换一个模块实例 + 换一个环境」就等价于「换一个构建产物」。
   *
   * 这条断言的价值在于：把「**生产环境不播演示账单**」变成可回归的
   * —— 它是「新账号凭空多出 ¥8720.72」那条污染链的最后一道闸。
   */
  const seedUrl = new URL('../src/api/mock/seed.js', import.meta.url).href
  let prodCounts = '?'
  try {
    const prevNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    let prodMod = null
    try {
      prodMod = await import(`${seedUrl}?prod=1`)
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prevNodeEnv
    }
    const ts = 1700000000000
    prodCounts = [
      prodMod.buildDemoBills(ts).length,
      prodMod.buildSeed(ts, { mode: 'full' }).bills.length,
      prodMod.buildSeed(ts, { mode: 'base' }).categories.length
    ].join(',')
  } catch (e) {
    prodCounts = `ERR:${e?.message || e}`
  }
  t.eq('1b-14 生产构建下演示账单为空、分类仍在（0 账单 / 42 分类）', prodCounts, '0,0,42')
}

/* ---------------- 2. 迁移 ---------------- */

{
  // 造一个「早期版本」的本地库：没有 seedExtra 标记，也没有补充账单，
  // 只有一笔用户自己记的账，外加一笔与种子 id 相同但内容被改过的账单。
  const old = {
    schemaVersion: SCHEMA_VERSION,
    ledgers: [{ id: ledgerId, name: '默认账本', ownerId: 'user_local' }],
    categories: [],
    bills: [
      {
        id: 'bill_user_1',
        ledgerId,
        type: 'expense',
        amount: 1.5,
        categoryId: 'cat_food',
        primaryCategoryId: 'cat_food',
        date: `${month}-05`,
        deleted: 0
      },
      {
        id: 'bill_seed_extra_01',
        ledgerId,
        type: 'income',
        amount: 99,
        categoryId: 'cat_salary',
        primaryCategoryId: 'cat_salary',
        date: `${month}-02`,
        remark: '我改过的',
        deleted: 0
      }
    ],
    meta: { seedNotes: 1 }
  }
  store.set(PERSIST_KEY, JSON.stringify(old))

  const rows = await fresh().bill.list({ ledgerId })
  const have = new Set(rows.map((b) => b.id))
  t.ok('迁移补上了 14 笔补充账单', have.has('bill_seed_extra_14'), `实得 ${rows.length} 条`)
  t.ok('用户自己记的账没被动', rows.some((b) => b.id === 'bill_user_1' && b.amount === 1.5))
  const kept = rows.find((b) => b.id === 'bill_seed_extra_01')
  t.ok('已存在的同 id 账单不被覆盖（金额/备注保持原样）', kept.amount === 99 && kept.remark === '我改过的', JSON.stringify(kept))

  const persisted = JSON.parse(store.get(PERSIST_KEY))
  t.eq('迁移标记已写回本地库', persisted.meta.seedExtra, SEED_EXTRA_VERSION)

  // 再开一个适配器（重新读同一份本地库）→ 不应重复插入
  const rows2 = await fresh().bill.list({ ledgerId })
  t.eq('迁移幂等：条数不变', rows2.length, rows.length)
  const monthIncome = rows2.filter(
    (b) => b.type === 'income' && date.monthKeyOf(b.date) === month
  ).length
  t.ok('本月收入账单没有重复（仍是 4 笔）', monthIncome === 4, `实得 ${monthIncome}`)
  t.eq(
    '补充账单合计 14 笔（含往月）',
    rows2.filter((b) => b.id.startsWith('bill_seed_extra_')).length,
    14
  )
}

t.done()
