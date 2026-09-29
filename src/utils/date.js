/* ---------------- 日期工具 ---------------- */

export function pad2(n) {
  return String(n).padStart(2, '0')
}

export function toDateKey(input) {
  const d = input instanceof Date ? input : new Date(input)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function todayKey() {
  return toDateKey(new Date())
}

export function currentMonthKey() {
  return todayKey().slice(0, 7)
}

export function monthKeyOf(dateKey) {
  return String(dateKey || '').slice(0, 7)
}

export function monthFirstKey(monthKey) {
  return `${monthKey || currentMonthKey()}-01`
}

/** 该月最后一天，如 2026-09 -> 2026-09-30 */
export function monthLastKey(monthKey) {
  const m = monthKey || currentMonthKey()
  return `${m}-${pad2(daysInMonth(m))}`
}

export function yearFirstKey(year) {
  return `${year}-01-01`
}

export function yearLastKey(year) {
  return `${year}-12-31`
}

/** 两个日期键之间的整天数（to - from），按 UTC 计算，不受时区/夏令时影响 */
export function daysBetween(fromKey, toKey) {
  const [ay, am, ad] = String(fromKey).split('-').map(Number)
  const [by, bm, bd] = String(toKey).split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

export function addDays(date, days) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

export function shiftMonth(monthKey, delta) {
  const [y, m] = String(monthKey).split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}

export function formatMonthLabel(monthKey) {
  const [y, m] = String(monthKey).split('-')
  return `${y}年${Number(m)}月`
}

/** 2026-09-27 -> 2026.09.27 */
export function formatDateDots(dateKey) {
  return String(dateKey).replace(/-/g, '.')
}

/** 2026-09-27 -> 9月27日 */
export function formatDateCN(dateKey) {
  const [, m, d] = String(dateKey).split('-')
  return `${Number(m)}月${Number(d)}日`
}

export function daysInMonth(monthKey) {
  const [y, m] = String(monthKey).split('-').map(Number)
  return new Date(y, m, 0).getDate()
}

/** 返回该月的日期矩阵（周一起始），用于日历视图 */
export function monthGrid(monthKey) {
  const [y, m] = String(monthKey).split('-').map(Number)
  const first = new Date(y, m - 1, 1)
  const lead = (first.getDay() + 6) % 7
  const total = daysInMonth(monthKey)
  const cells = []
  for (let i = 0; i < lead; i += 1) cells.push(null)
  for (let d = 1; d <= total; d += 1) cells.push(`${monthKey}-${pad2(d)}`)
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

export function weekdayLabels() {
  return ['一', '二', '三', '四', '五', '六', '日']
}
