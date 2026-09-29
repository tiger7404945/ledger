import { defineStore } from 'pinia'
import { billRepo } from '@/api'
import { useLedgerStore } from './ledger.js'
import {
  currentMonthKey,
  todayKey,
  monthKeyOf,
  monthFirstKey,
  monthLastKey,
  yearFirstKey,
  yearLastKey,
  shiftMonth as shiftMonthKey,
  formatMonthLabel,
  daysInMonth
} from '@/utils/date.js'
import { round2 } from '@/utils/money.js'

const emptySummary = (month = currentMonthKey()) => ({
  month,
  from: '',
  to: '',
  expense: 0,
  income: 0,
  balance: 0,
  budget: 0,
  remain: 0,
  dailyAvg: 0,
  daysElapsed: 1,
  daysInMonth: 30
})

/** 按日期分组（账单页流水视图） */
function groupByDate(bills) {
  const map = new Map()
  bills.forEach((b) => {
    if (!map.has(b.date)) map.set(b.date, { date: b.date, income: 0, expense: 0, items: [] })
    const g = map.get(b.date)
    g.items.push(b)
    if (b.type === 'income') g.income = round2(g.income + b.amount)
    else g.expense = round2(g.expense + b.amount)
  })
  return Array.from(map.values()).sort((a, b) => (a.date < b.date ? 1 : -1))
}

/**
 * 账单 store
 *
 * 两份互相独立的数据切片：
 * - **本月视角**（`month` / `bills` / `summary`）：首页与统计页固定用当前月，不受账单页筛选影响。
 * - **账单页筛选取景**（`period` / `periodBills` / `periodSummary`）：可切「按月 / 按年」。
 *   拆开是为了让账单页切到某一年时，首页与统计页仍然显示本月数据。
 *
 * 所有写操作走 repository，本地先行，后续由同步引擎推送到云端。
 */
export const useBillStore = defineStore('bill', {
  state: () => ({
    /** 本月视角：首页 / 统计页 */
    month: currentMonthKey(),
    bills: [],
    summary: emptySummary(),

    /** 账单页筛选取景 */
    period: {
      /** 'month' 按月 | 'year' 按年 */
      mode: 'month',
      month: currentMonthKey(),
      year: Number(currentMonthKey().slice(0, 4))
    },
    periodBills: [],
    periodSummary: emptySummary(),
    periodInitialized: false,

    loading: false,
    initialized: false,

    /** 搜索态 */
    searchKeyword: '',
    searchResults: [],
    searching: false
  }),

  getters: {
    /** 今日账单（首页） */
    todayBills(state) {
      const day = todayKey()
      return state.bills.filter((b) => b.date === day)
    },

    todayStat(state) {
      const day = todayKey()
      return state.bills
        .filter((b) => b.date === day)
        .reduce(
          (acc, b) => {
            if (b.type === 'income') acc.income = round2(acc.income + b.amount)
            else acc.expense = round2(acc.expense + b.amount)
            return acc
          },
          { income: 0, expense: 0 }
        )
    },

    /** 账单页：按日期分组 */
    groups(state) {
      return groupByDate(state.bills)
    },

    /** 每日收支（日历视图） */
    dailyMap(state) {
      const map = {}
      state.bills.forEach((b) => {
        const cur = map[b.date] || { income: 0, expense: 0 }
        if (b.type === 'income') cur.income = round2(cur.income + b.amount)
        else cur.expense = round2(cur.expense + b.amount)
        map[b.date] = cur
      })
      return map
    },

    isCurrentMonth(state) {
      return state.month === currentMonthKey()
    },

    /* ---------------- 账单页筛选取景 ---------------- */

    /** 当前筛选区间（含首尾的日期键） */
    periodRange(state) {
      if (state.period.mode === 'year') {
        return { from: yearFirstKey(state.period.year), to: yearLastKey(state.period.year) }
      }
      return { from: monthFirstKey(state.period.month), to: monthLastKey(state.period.month) }
    },

    /** 顶部显示的区间文案：2026年9月 / 2026年 */
    periodLabel(state) {
      return state.period.mode === 'year'
        ? `${state.period.year}年`
        : formatMonthLabel(state.period.month)
    },

    /** 「本月」/「本年」，结余卡片的小标题用它 */
    periodUnit(state) {
      return state.period.mode === 'year' ? '本年' : '本月'
    },

    /** 区间内的账单按日期分组（流水视图） */
    periodGroups(state) {
      return groupByDate(state.periodBills)
    },

    /** 区间内每日收支（日历视图，按月模式） */
    periodDailyMap(state) {
      const map = {}
      state.periodBills.forEach((b) => {
        const cur = map[b.date] || { income: 0, expense: 0 }
        if (b.type === 'income') cur.income = round2(cur.income + b.amount)
        else cur.expense = round2(cur.expense + b.amount)
        map[b.date] = cur
      })
      return map
    },

    /** 区间内各月收支（日历视图，按年模式的年度总览） */
    periodMonthlyMap(state) {
      const map = {}
      state.periodBills.forEach((b) => {
        const key = b.date.slice(0, 7)
        const cur = map[key] || { income: 0, expense: 0 }
        if (b.type === 'income') cur.income = round2(cur.income + b.amount)
        else cur.expense = round2(cur.expense + b.amount)
        map[key] = cur
      })
      return map
    }
  },

  actions: {
    async ensureLoaded(force = false) {
      if (this.initialized && !force) return
      await this.refresh()
      this.initialized = true
    },

    async refresh() {
      const ledger = useLedgerStore()
      await ledger.ensureLoaded()
      this.loading = true
      try {
        const [bills, summary] = await Promise.all([
          billRepo.list({ ledgerId: ledger.currentId, month: this.month, order: 'desc' }),
          billRepo.summary({ ledgerId: ledger.currentId, month: this.month })
        ])
        this.bills = bills
        this.summary = summary
      } finally {
        this.loading = false
      }
    },

    async setMonth(month) {
      if (this.month === month) return
      this.month = month
      await this.refresh()
    },

    async shiftMonth(delta) {
      this.month = shiftMonthKey(this.month, delta)
      await this.refresh()
    },

    /* ---------------- 账单页筛选取景 ---------------- */

    async ensurePeriodLoaded(force = false) {
      if (this.periodInitialized && !force) return
      await this.refreshPeriod()
      this.periodInitialized = true
    },

    /** 按当前 period 拉取区间账单与汇总 */
    async refreshPeriod() {
      const ledger = useLedgerStore()
      await ledger.ensureLoaded()
      const { from, to } = this.periodRange
      this.loading = true
      try {
        const [bills, summary] = await Promise.all([
          billRepo.list({ ledgerId: ledger.currentId, from, to, order: 'desc' }),
          billRepo.summary({ ledgerId: ledger.currentId, from, to })
        ])
        this.periodBills = bills
        this.periodSummary = summary
      } finally {
        this.loading = false
      }
    },

    /** 按月查看 / 按年查看 切换（区间切到当前 year / month） */
    async setPeriodMode(mode) {
      if (this.period.mode === mode || (mode !== 'month' && mode !== 'year')) return
      this.period.mode = mode
      await this.refreshPeriod()
    },

    async setPeriodMonth(month) {
      const changed = this.period.mode !== 'month' || this.period.month !== month
      this.period.mode = 'month'
      this.period.month = month
      this.period.year = Number(String(month).slice(0, 4))
      if (changed) await this.refreshPeriod()
    },

    async setPeriodYear(year) {
      const changed = this.period.mode !== 'year' || this.period.year !== year
      this.period.mode = 'year'
      this.period.year = year
      if (changed) await this.refreshPeriod()
    },

    /** 顶部 ‹ › ：按月模式翻月，按年模式翻年 */
    async shiftPeriod(delta) {
      if (this.period.mode === 'year') return this.setPeriodYear(this.period.year + delta)
      return this.setPeriodMonth(shiftMonthKey(this.period.month, delta))
    },

    /** 「重置演示数据」后把账单页筛选退回本月 */
    resetPeriod() {
      const m = currentMonthKey()
      this.period = { mode: 'month', month: m, year: Number(m.slice(0, 4)) }
    },

    async createBill(payload) {
      const ledger = useLedgerStore()
      const doc = await billRepo.create({
        ledgerId: ledger.currentId,
        date: payload.date || todayKey(),
        type: payload.type || 'expense',
        ...payload
      })
      await this.refresh()
      if (this.periodInitialized) await this.refreshPeriod()
      return doc
    },

    async updateBill(id, patch) {
      const doc = await billRepo.update(id, patch)
      // 编辑后日期可能跨月/跨年，把两个视角都移到该账单所属月份，保证可见
      const mk = monthKeyOf(patch.date)
      if (mk) {
        if (mk !== this.month) this.month = mk
        const inPeriod =
          this.period.mode === 'year'
            ? Number(mk.slice(0, 4)) === this.period.year
            : mk === this.period.month
        if (!inPeriod) {
          this.period.mode = 'month'
          this.period.month = mk
          this.period.year = Number(mk.slice(0, 4))
        }
      }
      await this.refresh()
      if (this.periodInitialized) await this.refreshPeriod()
      if (this.searchKeyword) await this.search(this.searchKeyword)
      return doc
    },

    async deleteBill(id) {
      await billRepo.remove(id)
      await this.refresh()
      if (this.periodInitialized) await this.refreshPeriod()
      if (this.searchKeyword) await this.search(this.searchKeyword)
      return true
    },

    async getBill(id) {
      return billRepo.get(id)
    },

    /**
     * 某分类下的历史备注（记账页「填写备注」的候选）
     * 去重、按最近保存时间从新到旧
     * @param {string} categoryId 二级分类优先，无二级时为一级分类
     * @param {number} limit
     * @returns {Promise<string[]>}
     */
    async remarkHistory(categoryId, limit = 15) {
      if (!categoryId) return []
      const ledger = useLedgerStore()
      await ledger.ensureLoaded()
      return billRepo.remarkHistory({ ledgerId: ledger.currentId, categoryId, limit })
    },

    /** 搜索：备注 / 分类名（含二级全名）/ 金额 */
    async search(keyword) {
      this.searchKeyword = keyword
      const kw = String(keyword || '').trim()
      if (!kw) {
        this.searchResults = []
        return []
      }
      const ledger = useLedgerStore()
      this.searching = true
      try {
        const rows = await billRepo.list({ ledgerId: ledger.currentId, keyword: kw, order: 'desc' })
        this.searchResults = rows
        return rows
      } finally {
        this.searching = false
      }
    },

    clearSearch() {
      this.searchKeyword = ''
      this.searchResults = []
    },

    /** 账单页日历视图：某月每天的收支 */
    async calendarOf(month) {
      const ledger = useLedgerStore()
      const rows = await billRepo.list({ ledgerId: ledger.currentId, month, order: 'asc' })
      const map = {}
      rows.forEach((b) => {
        const cur = map[b.date] || { income: 0, expense: 0 }
        if (b.type === 'income') cur.income = round2(cur.income + b.amount)
        else cur.expense = round2(cur.expense + b.amount)
        map[b.date] = cur
      })
      return { rows, map, days: daysInMonth(month) }
    }
  }
})
