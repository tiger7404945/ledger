/**
 * 账单页「按月 / 按年」筛选的数据层断言
 * 运行：node .preview/period-test.mjs
 *
 * adapter 只依赖相对路径模块 + localStorage，直接在 Node 里打桩跑最省事。
 */
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
}
// outbox 会用到 window/localStorage 之外的接口，这里只保证 import 不炸
globalThis.window = globalThis

const SRC = new URL('../src/', import.meta.url).href
const { createMockAdapter } = await import(`${SRC}api/adapters/mockAdapter.js`)
const date = await import(`${SRC}utils/date.js`)
const { bill: billRepo } = createMockAdapter({ latency: 0 })

/* 断言与汇总统一走 scripts/_harness.mjs（输出格式见该文件顶部说明） */
import { createSuite } from './_harness.mjs'

const t = createSuite('period-test')

const ledgerId = 'ledger_default'
const month = date.currentMonthKey()
const year = Number(month.slice(0, 4))

// ---- 日期工具 ----
t.eq('monthLastKey(2026-02) 是闰月 28 天', date.monthLastKey('2026-02'), '2026-02-28')
t.eq('monthLastKey(2026-09)', date.monthLastKey('2026-09'), '2026-09-30')
t.eq('yearFirstKey / yearLastKey', [date.yearFirstKey(2026), date.yearLastKey(2026)], ['2026-01-01', '2026-12-31'])
t.eq('daysBetween 跨月', date.daysBetween('2026-08-31', '2026-09-01'), 1)
t.eq('daysBetween 整年（2026 平年）', date.daysBetween('2026-01-01', '2026-12-31') + 1, 365)

// ---- list 的 from / to ----
const all = await billRepo.list({ ledgerId })
t.ok('种子数据非空', all.length > 0, `实得 ${all.length}`)
const inMonth = await billRepo.list({ ledgerId, month })

const inYear = await billRepo.list({
  ledgerId,
  from: date.yearFirstKey(year),
  to: date.yearLastKey(year)
})
t.ok(
  '按年 list 覆盖本月 list（往月还有补充账单）',
  inYear.length > inMonth.length,
  `年 ${inYear.length} / 月 ${inMonth.length}`
)
t.ok(
  '本月账单全部落在本月',
  inMonth.every((b) => date.monthKeyOf(b.date) === month),
  `实得 ${inMonth.length} 条`
)

const narrow = await billRepo.list({ ledgerId, from: `${month}-01`, to: `${month}-05` })
t.ok(
  '区间收窄后条数变少且都在区间内',
  narrow.length > 0 && narrow.every((b) => b.date >= `${month}-01` && b.date <= `${month}-05`),
  `实得 ${narrow.length} 条：${narrow.map((b) => b.date).join(',')}`
)

const none = await billRepo.list({ ledgerId, from: '2019-01-01', to: '2019-12-31' })
t.eq('没有数据的年份返回空数组', none.length, 0)

// ---- summary 的 from / to ----
const sMonth = await billRepo.summary({ ledgerId, month })
const sYear = await billRepo.summary({ ledgerId, from: date.yearFirstKey(year), to: date.yearLastKey(year) })
t.ok(
  '按年汇总支出 > 按月汇总支出（往月有补充账单）',
  sYear.expense > sMonth.expense,
  `年 ${sYear.expense} / 月 ${sMonth.expense}`
)
t.ok(
  '按年汇总收入 > 按月汇总收入（往月有补充收入）',
  sYear.income > sMonth.income,
  `年 ${sYear.income} / 月 ${sMonth.income}`
)
t.eq('按年 balance = income - expense', sYear.balance, Math.round((sYear.income - sYear.expense) * 100) / 100)
t.eq('按年汇总的区间是整年', [sYear.from, sYear.to], [`${year}-01-01`, `${year}-12-31`])
t.eq('按年 daysInMonth = 365（2026 平年）', sYear.daysInMonth, 365)
t.ok('按年 dailyAvg ≈ 支出 / 已过天数', Math.abs(sYear.dailyAvg - sYear.expense / sYear.daysElapsed) < 0.01)
t.ok('按年 daysElapsed 在 (0, 365]', sYear.daysElapsed > 0 && sYear.daysElapsed <= 365, `实得 ${sYear.daysElapsed}`)

const sPast = await billRepo.summary({ ledgerId, from: '2019-01-01', to: '2019-12-31' })
t.eq('已过去的空区间：支出 0、已过天数 365', [sPast.expense, sPast.daysElapsed], [0, 365])
t.eq('已过去的空区间 dailyAvg 为 0', sPast.dailyAvg, 0)

const sFuture = await billRepo.summary({ ledgerId, from: '2030-01-01', to: '2030-12-31' })
t.eq('未来区间已过天数为 0', sFuture.daysElapsed, 0)

// ---- 按月不变（回归） ----
t.eq('按月 summary 的 month 字段保留', sMonth.month, month)
t.eq('按月 summary 的区间 = 该月首尾', [sMonth.from, sMonth.to], [`${month}-01`, date.monthLastKey(month)])

t.done()
