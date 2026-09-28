import { defineStore } from 'pinia'
import { ledgerRepo } from '@/api'

/** 账本 store：目前固定「默认账本」，预留多账本切换 */
export const useLedgerStore = defineStore('ledger', {
  state: () => ({
    ledgers: [],
    currentId: 'ledger_default',
    loading: false,
    initialized: false
  }),

  getters: {
    current(state) {
      return state.ledgers.find((l) => l.id === state.currentId) || {
        id: state.currentId,
        name: '默认账本'
      }
    },
    currentName() {
      return this.current.name
    }
  },

  actions: {
    async ensureLoaded() {
      if (this.initialized) return
      this.loading = true
      try {
        this.ledgers = await ledgerRepo.list()
        if (this.ledgers.length && !this.ledgers.some((l) => l.id === this.currentId)) {
          this.currentId = this.ledgers[0].id
        }
        this.initialized = true
      } finally {
        this.loading = false
      }
    },

    switchTo(id) {
      this.currentId = id
    }
  }
})
