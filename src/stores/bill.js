import { defineStore } from 'pinia'
import { billRepo } from '@/api'
import { useLedgerStore } from './ledger.js'
import { currentMonthKey, todayKey, monthKeyOf, daysInMonth } from '@/utils/date.js'
import { round2 } from '@/utils/money.js'

/**
 * 账单 store
 * - 列表按月份维护；今日账单、搜索结果为派生数据
 * - 所有写操作走 repository，本地先行，后续由同步引擎推送到云端
 */
export const useBillStore = defineStore('bill', {
  state: () => ({
    month: currentMonthKey(),
    bills: [],
    summary: {
      month: currentMonthKey(),
      expense: 0,
      income: 0,
      balance: 0,
      budget: 0,
      remain: 0,
      dailyAvg: 0,
      daysElapsed: 1,
      daysInMonth: 30
    },
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
      const map = new Map()
      state.bills.forEach((b) => {
        if (!map.has(b.date)) map.set(b.date, { date: b.date, income: 0, expense: 0, items: [] })
        const g = map.get(b.date)
        g.items.push(b)
        if (b.type === 'income') g.income = round2(g.income + b.amount)
        else g.expense = round2(g.expense + b.amount)
      })
      return Array.from(map.values()).sort((a, b) => (a.date < b.date ? 1 : -1))
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
      const [y, m] = this.month.split('-').map(Number)
      const d = new Date(y, m - 1 + delta, 1)
      const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      await this.setMonth(next)
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
      return doc
    },

    async updateBill(id, patch) {
      const doc = await billRepo.update(id, patch)
      // 编辑后日期可能跨月，回到该账单所属月份以保证可见
      const targetMonth = monthKeyOf(patch.date) || this.month
      if (monthKeyOf(patch.date) && monthKeyOf(patch.date) !== this.month) {
        this.month = targetMonth
      }
      await this.refresh()
      if (this.searchKeyword) await this.search(this.searchKeyword)
      return doc
    },

    async deleteBill(id) {
      await billRepo.remove(id)
      await this.refresh()
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
