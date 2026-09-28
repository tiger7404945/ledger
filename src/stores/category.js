import { defineStore } from 'pinia'
import { categoryRepo } from '@/api'
import { useLedgerStore } from './ledger.js'

/**
 * 分类 store
 * 一级分类（parentId === null）与二级分类统一存放，按需派生。
 */
export const useCategoryStore = defineStore('category', {
  state: () => ({
    list: [],
    loading: false,
    initialized: false
  }),

  getters: {
    byId(state) {
      const map = {}
      state.list.forEach((c) => {
        map[c.id] = c
      })
      return map
    },

    /** 一级分类，按 type 过滤 */
    primaries(state) {
      return (type = 'expense') =>
        state.list.filter((c) => !c.parentId && c.type === type).sort((a, b) => a.order - b.order)
    },

    /** 某一级分类下的二级分类 */
    children(state) {
      return (parentId) =>
        state.list.filter((c) => c.parentId === parentId).sort((a, b) => a.order - b.order)
    },

    /** 是否含有二级分类（宫格角标） */
    hasChildren(state) {
      return (parentId) => state.list.some((c) => c.parentId === parentId)
    },

    /** 分类展示名：二级 -> 「交通-公交地铁」 */
    label(state) {
      return (id) => {
        const cat = state.list.find((c) => c.id === id)
        if (!cat) return '未分类'
        if (!cat.parentId) return cat.name
        const parent = state.list.find((c) => c.id === cat.parentId)
        return parent ? `${parent.name}-${cat.name}` : cat.name
      }
    },

    /** 记账页展开二级面板时使用：一级 + 其二级 */
    tree(state) {
      return (type = 'expense') =>
        state.list
          .filter((c) => c.type === type && !c.parentId)
          .sort((a, b) => a.order - b.order)
          .map((parent) => ({
            ...parent,
            children: state.list
              .filter((c) => c.parentId === parent.id)
              .sort((a, b) => a.order - b.order)
          }))
    }
  },

  actions: {
    async ensureLoaded(force = false) {
      if (this.initialized && !force) return
      this.loading = true
      try {
        const ledger = useLedgerStore()
        await ledger.ensureLoaded()
        this.list = await categoryRepo.list({ ledgerId: ledger.currentId })
        this.initialized = true
      } finally {
        this.loading = false
      }
    },

    async createCategory(payload) {
      const ledger = useLedgerStore()
      const doc = await categoryRepo.create({
        ledgerId: ledger.currentId,
        ...payload
      })
      await this.ensureLoaded(true)
      return doc
    },

    async updateCategory(id, patch) {
      const doc = await categoryRepo.update(id, patch)
      await this.ensureLoaded(true)
      return doc
    },

    async removeCategory(id, { cascade = true } = {}) {
      await categoryRepo.remove(id, { cascade })
      await this.ensureLoaded(true)
    },

    /** 分类被删除后，账单里引用的分类需要兜底（避免悬空 id） */
    resolveOrNull(id) {
      return this.byId[id] ? id : null
    }
  }
})
