/**
 * ============================================================
 *  查询与派生逻辑（纯函数，无 IO）
 * ============================================================
 *  为什么单独抽这一层：
 *    mockAdapter / idbAdapter / 未来的云端适配器都要实现同一套过滤、排序、
 *    聚合与派生字段的规则。如果每个适配器各写一份，规则一定会漂（本项目已经
 *    在 PeriodSwitch 上吃过「两处实现各写一套、慢慢漂开」的亏）。
 *    所以这里只放「给定数据数组 + 查询条件 → 返回结果」的纯函数，
 *    适配器负责取数（内存 / IndexedDB / 云端）与写回，规则统一从这里调用。
 *
 *  约定：本文件不 import 任何适配器，也不碰 localStorage / IndexedDB。
 */
import {
  monthKeyOf,
  monthFirstKey,
  monthLastKey,
  daysBetween,
  currentMonthKey,
  todayKey
} from '../../utils/date.js'
import { round2 } from '../../utils/money.js'

/** 软删除标记：1 / true 视为已删除 */
export const alive = (doc) => !doc.deleted

/* ---------------- 分类查找 ---------------- */

/**
 * 建一个分类查找表（只索引未删除的分类）。
 * decorate 会被逐条调用，这里先在外部建好 Map，避免每条账单都重新扫一遍数组。
 * @param {Array} categories
 */
export function createCategoryLookup(categories = []) {
  const byId = new Map()
  categories.filter(alive).forEach((c) => byId.set(c.id, c))
  return {
    get: (id) => (id ? byId.get(id) || null : null),
    /**
     * 分类展示名：一级 → 「交通」，二级 → 「交通-公交地铁」
     * 找不到分类时返回「未分类」（与第一阶段 mockAdapter 的行为一致）
     */
    label(id) {
      const cat = this.get(id)
      if (!cat) return '未分类'
      if (!cat.parentId) return cat.name
      const parent = this.get(cat.parentId)
      return parent ? `${parent.name}-${cat.name}` : cat.name
    }
  }
}

/* ---------------- 分类 ---------------- */

/**
 * @param {Array} categories 全部分类
 * @param {{ledgerId?:string, type?:string, parentId?:string|null, includeDeleted?:boolean}} query
 */
export function filterCategories(categories, query = {}) {
  const { ledgerId, type, parentId, includeDeleted = false } = query
  return categories
    .filter((c) => (includeDeleted ? true : alive(c)))
    .filter((c) => (ledgerId ? c.ledgerId === ledgerId : true))
    .filter((c) => (type ? c.type === type : true))
    .filter((c) => (parentId === undefined ? true : c.parentId === parentId))
    .sort(byCategoryOrder)
    .map((c) => ({ ...c }))
}

/**
 * 分类排序：先按 order，order 相同时用 id 兜底。
 *
 * 为什么必须兜底：order 只在「同级同类型」内唯一，一级与二级之间会大量重复
 * （每个一级分类的 order 从 0 开始）。只按 order 排的话，相同 order 的元素相对
 * 顺序取决于底层存储的返回顺序 —— 内存数组是插入序、IndexedDB 是按主键序，
 * 两个适配器就会给出不同结果，进而让契约测试失败、也让页面表现随存储实现变化。
 */
function byCategoryOrder(a, b) {
  if (a.order !== b.order) return a.order - b.order
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/* ---------------- 账单 ---------------- */

/** 给账单补上分类名 / 图标 / 展示名等派生字段（列表与详情都要用） */
export function decorateBill(bill, lookup) {
  const cat = lookup.get(bill.categoryId)
  const primary = lookup.get(bill.primaryCategoryId)
  return {
    ...bill,
    categoryName: cat ? cat.name : '未分类',
    categoryIcon: cat ? cat.icon : 'more',
    primaryCategoryName: primary ? primary.name : '',
    primaryCategoryIcon: primary ? primary.icon : 'more',
    displayName: lookup.label(bill.categoryId)
  }
}

/**
 * 账单过滤 + 派生 + 排序
 *
 * @param {Array} bills 全部账单
 * @param {Array} categories 全部分类（用于派生展示名）
 * @param {{ledgerId?:string, month?:string, from?:string, to?:string, date?:string,
 *          type?:string, categoryId?:string, keyword?:string, order?:'asc'|'desc'}} query
 *   from / to 为 'YYYY-MM-DD'（含首尾），与 month 同时传入时按 AND 处理
 */
export function filterBills(bills, categories, query = {}) {
  const { ledgerId, month, from, to, date, type, categoryId, keyword, order = 'desc' } = query
  const kw = String(keyword || '').trim().toLowerCase()

  let rows = bills
    .filter((b) => alive(b))
    .filter((b) => (ledgerId ? b.ledgerId === ledgerId : true))
    .filter((b) => (type ? b.type === type : true))
    .filter((b) => (categoryId ? b.categoryId === categoryId : true))
    .filter((b) => (month ? monthKeyOf(b.date) === month : true))
    .filter((b) => (from ? b.date >= from : true))
    .filter((b) => (to ? b.date <= to : true))
    .filter((b) => (date ? b.date === date : true))

  const lookup = createCategoryLookup(categories)
  rows = rows.map((b) => decorateBill(b, lookup))

  // 关键字匹配备注、分类展示名（含二级全名）与金额文本
  if (kw) {
    rows = rows.filter((b) => {
      const amountText = b.amount.toFixed(2)
      return (
        b.displayName.toLowerCase().includes(kw) ||
        String(b.remark || '').toLowerCase().includes(kw) ||
        amountText.includes(kw)
      )
    })
  }

  // 先按日期，同一天内按创建时间；两条都随 order 反转
  rows.sort((a, b) => {
    const diff = a.date === b.date ? b.createdAt - a.createdAt : a.date < b.date ? 1 : -1
    return order === 'desc' ? diff : -diff
  })
  return rows
}

/** 按日期分组（账单页流水视图）：每天一行，带当天收/支合计 */
export function groupBillsByDate(rows) {
  const map = new Map()
  rows.forEach((b) => {
    if (!map.has(b.date)) map.set(b.date, { date: b.date, income: 0, expense: 0, items: [] })
    const group = map.get(b.date)
    group.items.push(b)
    if (b.type === 'income') group.income = round2(group.income + b.amount)
    else group.expense = round2(group.expense + b.amount)
  })
  return Array.from(map.values())
}

/** 某天的收支汇总（日历视图） */
export function dailySummaryOf(rows) {
  const map = new Map()
  rows.forEach((b) => {
    const cur = map.get(b.date) || { date: b.date, income: 0, expense: 0, count: 0 }
    if (b.type === 'income') cur.income = round2(cur.income + b.amount)
    else cur.expense = round2(cur.expense + b.amount)
    cur.count += 1
    map.set(b.date, cur)
  })
  return Array.from(map.values())
}

/**
 * 区间汇总（首页总览 / 账单页结余卡片）
 * 用 month 传月度区间，或用 from / to 传任意区间（账单页按年筛选）
 */
export function summarizeBills(bills, query = {}) {
  const ledgerId = query.ledgerId
  const { from, to } = query
  const month = query.month || (from ? '' : currentMonthKey())

  const rows = bills
    .filter((b) => alive(b))
    .filter((b) => (ledgerId ? b.ledgerId === ledgerId : true))
    .filter((b) => (month ? monthKeyOf(b.date) === month : true))
    .filter((b) => (from ? b.date >= from : true))
    .filter((b) => (to ? b.date <= to : true))

  const expense = round2(
    rows.filter((b) => b.type === 'expense').reduce((a, b) => a + b.amount, 0)
  )
  const income = round2(rows.filter((b) => b.type === 'income').reduce((a, b) => a + b.amount, 0))

  // 已过天数：区间起始日到今天，落在区间内；区间还没开始为 0，已经结束为整天数
  const start = from || monthFirstKey(month)
  const end = to || monthLastKey(month)
  const today = todayKey()
  const totalDays = daysBetween(start, end) + 1
  const elapsed =
    today >= end ? totalDays : today < start ? 0 : Math.min(totalDays, daysBetween(start, today) + 1)

  return {
    month,
    from: start,
    to: end,
    expense,
    income,
    balance: round2(income - expense),
    budget: 0,
    remain: 0,
    dailyAvg: elapsed > 0 ? round2(expense / elapsed) : 0,
    daysElapsed: elapsed,
    daysInMonth: totalDays
  }
}

/**
 * 某分类下的历史备注（记账页「填写备注」的候选）
 * - 只取该分类的账单，空备注过滤掉
 * - 同一条备注去重，保留最近一次保存的时间
 * - 按最近保存时间从新到旧，最多 limit 条
 * @returns {string[]}
 */
export function remarkHistoryOf(bills, query = {}) {
  const { ledgerId, categoryId, limit = 15 } = query
  if (!categoryId) return []

  const latest = new Map()
  bills
    .filter((b) => alive(b))
    .filter((b) => (ledgerId ? b.ledgerId === ledgerId : true))
    .filter((b) => b.categoryId === categoryId)
    .forEach((b) => {
      const text = String(b.remark || '').trim()
      if (!text) return
      const ts = b.updatedAt || b.createdAt || 0
      const prev = latest.get(text)
      if (!prev || ts > prev) latest.set(text, ts)
    })

  return Array.from(latest.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([text]) => text)
}
