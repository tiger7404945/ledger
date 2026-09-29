/**
 * 演示账单备注回填迁移的断言
 * 运行：npm run test:data
 */
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
}

const BASE = new URL('../src/', import.meta.url).href
const { buildSeed } = await import(`${BASE}api/mock/seed.js`)
const { createMockAdapter } = await import(`${BASE}api/adapters/mockAdapter.js`)

const KEY = 'ledger.db.v1'
const LEDGER = 'ledger_default'
const assert = (label, cond, extra = '') =>
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`)

/* ---------- 1. 全新库：播种即带备注 ---------- */
const fresh = buildSeed()
assert('全新播种的账单带备注', fresh.bills.some((b) => b.remark))
assert('全新播种带迁移标记', fresh.meta?.seedNotes === 1)

/* ---------- 2. 旧库（无备注、无 meta）：加载时回填 ---------- */
const seed = buildSeed()
const aged = { schemaVersion: 1, ...seed }
aged.bills.forEach((b) => {
  b.remark = ''
})
delete aged.meta
aged.bills[0].remark = 'OWN_NOTE' // 模拟用户自己写过的备注
store.set(KEY, JSON.stringify(aged))

const db = createMockAdapter({ latency: 0 })
const foodNotes = await db.bill.remarkHistory({ ledgerId: LEDGER, categoryId: 'cat_food' })
const after = JSON.parse(store.get(KEY))
const withRemark = after.bills.filter((b) => b.remark).length

assert('旧库回填后有备注的账单数 > 0', withRemark > 0, `${withRemark}/${after.bills.length}`)
assert('旧库回填后写入迁移标记', after.meta?.seedNotes === 1)
assert('用户自己的备注未被覆盖', after.bills[0].remark === 'OWN_NOTE', after.bills[0].remark)
assert('餐饮历史备注可查到', foodNotes.length >= 4, foodNotes.join(' | '))
assert('备注按新到旧排序（首条为最近一条）', foodNotes[0] === '公司食堂', foodNotes[0])

/* ---------- 3. 幂等：二次加载不再改动 ---------- */
const before = JSON.stringify(store.get(KEY))
const db2 = createMockAdapter({ latency: 0 })
await db2.bill.remarkHistory({ ledgerId: LEDGER, categoryId: 'cat_food' })
assert('二次加载幂等（数据不变）', JSON.stringify(store.get(KEY)) === before)

/* ---------- 4. 二级分类精确匹配 ---------- */
const parking = await db.bill.remarkHistory({ ledgerId: LEDGER, categoryId: 'sub_traffic-parking' })
assert('二级分类「停车费」只取自己的备注', parking.length === 1 && parking[0] === '停车场', parking.join(' | '))

const traffic = await db.bill.remarkHistory({ ledgerId: LEDGER, categoryId: 'cat_traffic' })
assert('一级分类「交通」只取直接挂在它下面的备注', traffic.length === 1 && traffic[0] === 'ETC', traffic.join(' | '))

/* ---------- 5. 已删除账单不参与候选 ---------- */
const first = after.bills.find((b) => b.categoryId === 'cat_food' && b.remark)
await db.bill.remove(first.id)
const afterRemove = await db.bill.remarkHistory({ ledgerId: LEDGER, categoryId: 'cat_food' })
assert('删除后该备注从候选中消失', !afterRemove.includes(first.remark), afterRemove.join(' | '))
