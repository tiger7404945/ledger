/* ---------------- 金额工具 ---------------- */

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100
}

/** 8720.7 -> "8720.70"（不带货币符号、不带千分位，与参考设计一致） */
export function formatMoney(value) {
  const n = Math.abs(round2(value || 0))
  return n.toFixed(2)
}

/** 8720.7 -> { int: "8720", dec: ".70" }，用于大号金额排版 */
export function splitMoney(value) {
  const text = formatMoney(value)
  const [int, dec] = text.split('.')
  return { int, dec: `.${dec}` }
}

/** 记账面板金额显示：0 -> "0.00"，12.5 -> "12.5"，12.50 -> "12.50" */
export function formatTyping(input) {
  const s = String(input == null ? '' : input)
  if (s === '') return '0.00'
  if (s.endsWith('.')) return `${s}00`
  const [int, dec] = s.split('.')
  if (dec === undefined) return s
  if (dec.length === 1) return `${int}.${dec}0`
  return `${int}.${dec.slice(0, 2)}`
}

/** 校验并归一化金额，非法返回 0 */
export function toAmount(input) {
  const n = Number(input)
  if (!Number.isFinite(n) || n <= 0) return 0
  return round2(n)
}
