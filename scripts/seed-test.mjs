/**
 * 种子数据与迁移的断言
 * 运行：node .preview/seed-test.mjs
 *
 * 覆盖两件事：
 * 1. 新种子：本月支出仍是设计稿的 8720.72，补充的收入/往月账单金额对得上
 * 2. 迁移：早期本地库（没有 seedExtra 标记）加载时会补上补充账单，且
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
const { buildSeed, SEED_EXTRA_VERSION } = await import(`${SRC}api/mock/seed.js`)
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
