import {
  COLLECTIONS,
  NAME_MAX_LENGTH,
  RepositoryError,
  SCHEMA_VERSION
} from '../contract.js'
import { outbox } from '../sync/outbox.js'
import { buildSeed } from '../mock/seed.js'
import { migrateSeedData } from '../core/migrate.js'
import { now, uid } from '../../utils/id.js'
import { todayKey } from '../../utils/date.js'
import { round2 } from '../../utils/money.js'
import {
  alive,
  createCategoryLookup,
  filterCategories,
  filterBills,
  groupBillsByDate,
  dailySummaryOf,
  summarizeBills,
  remarkHistoryOf,
  decorateBill
} from '../core/query.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Mock 适配器：内存 + localStorage 持久化。
 * 完全实现 contract.js 中定义的 Repository 契约，行为与后续的
 * idbAdapter / leancloudAdapter 保持一致（均为 Promise、均写 outbox）。
 *
 * @returns {ReturnType<typeof createMockAdapter>}
 */
export function createMockAdapter({ latency = 24, persistKey = 'ledger.db.v1' } = {}) {
  let state = null
  let loadPromise = null

  /* ---------------- 内部：持久化 ---------------- */

  /**
   * 轻量数据迁移（幂等，规则见 core/migrate.js）
   * 演示账单的备注回填 + 后加的演示账单补齐，都只补「本地没有的」，不动用户的数据。
   * @returns {boolean} 是否有改动
   */
  function migrate(s) {
    const meta = s.meta || (s.meta = {})
    const bills = s.bills || (s.bills = [])
    return migrateSeedData(bills, meta).changed
  }

  function load() {
    if (state) return state
    try {
      const raw = localStorage.getItem(persistKey)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && parsed.schemaVersion === SCHEMA_VERSION) {
          state = parsed
          if (migrate(state)) persist()
          return state
        }
      }
    } catch (e) {
      /* 忽略损坏数据，重新播种 */
    }
    state = { schemaVersion: SCHEMA_VERSION, ...buildSeed() }
    persist()
    return state
  }

  function persist() {
    try {
      localStorage.setItem(persistKey, JSON.stringify(state))
    } catch (e) {
      /* 忽略配额错误 */
    }
  }

  async function ready() {
    if (!loadPromise) loadPromise = delay(latency).then(load)
    await loadPromise
    return state
  }

  function enqueue(collection, op, docId, payload) {
    outbox.enqueue({
      id: uid('ob'),
      collection,
      op,
      docId,
      payload,
      ts: now()
    })
  }

  function findCategory(id) {
    return load().categories.find((c) => c.id === id && alive(c)) || null
  }

  function findBill(id) {
    return load().bills.find((b) => b.id === id && alive(b)) || null
  }

  /** 当前状态的分类查找表（派生展示名用） */
  function lookupOf(s) {
    return createCategoryLookup(s.categories)
  }

  /* ---------------- 账本 ---------------- */

  const ledgerApi = {
    async list() {
      const s = await ready()
      return s.ledgers.map((l) => ({ ...l }))
    },
    async get(id) {
      const s = await ready()
      const item = s.ledgers.find((l) => l.id === id)
      return item ? { ...item } : null
    },
    async update(id, patch) {
      const s = await ready()
      const item = s.ledgers.find((l) => l.id === id)
      if (!item) throw new RepositoryError('NOT_FOUND', '账本不存在')
      Object.assign(item, patch, { updatedAt: now() })
      persist()
      enqueue(COLLECTIONS.LEDGER, 'update', id, { ...item })
      return { ...item }
    }
  }

  /* ---------------- 分类 ---------------- */

  const categoryApi = {
    /** @param {{ledgerId?:string, type?:string, parentId?:string|null, includeDeleted?:boolean}} query */
    async list(query = {}) {
      const s = await ready()
      return filterCategories(s.categories, query)
    },

    async get(id) {
      await ready()
      const cat = findCategory(id)
      return cat ? { ...cat } : null
    },

    async listChildren(parentId) {
      const s = await ready()
      return s.categories
        .filter((c) => alive(c) && c.parentId === parentId)
        .sort((a, b) => a.order - b.order)
        .map((c) => ({ ...c }))
    },

    /**
     * @param {{name:string, icon:string, parentId?:string|null, type:string, ledgerId:string}} payload
     */
    async create(payload) {
      const s = await ready()
      const name = String(payload.name || '').trim()
      if (!name) throw new RepositoryError('EMPTY_NAME', '请输入分类名称')
      if (name.length > NAME_MAX_LENGTH) {
        throw new RepositoryError('NAME_TOO_LONG', `分类名称最多 ${NAME_MAX_LENGTH} 个字`)
      }

      const parentId = payload.parentId || null
      if (parentId && !findCategory(parentId)) {
        throw new RepositoryError('PARENT_NOT_FOUND', '所属一级分类不存在')
      }

      const duplicated = s.categories.some(
        (c) =>
          alive(c) &&
          c.name === name &&
          c.type === payload.type &&
          (c.parentId || null) === parentId &&
          c.ledgerId === payload.ledgerId
      )
      if (duplicated) throw new RepositoryError('DUPLICATE_NAME', '分类名称已存在')

      const siblings = s.categories.filter(
        (c) => c.parentId === parentId && c.type === payload.type && c.ledgerId === payload.ledgerId
      )
      const doc = {
        id: uid(payload.parentId ? 'sub' : 'cat'),
        name,
        icon: payload.icon || 'more',
        parentId,
        type: payload.type,
        ledgerId: payload.ledgerId,
        order: siblings.length,
        createdAt: now(),
        updatedAt: now(),
        deleted: 0
      }
      s.categories.push(doc)
      persist()
      enqueue(COLLECTIONS.CATEGORY, 'create', doc.id, { ...doc })
      return { ...doc }
    },

    async update(id, patch) {
      const s = await ready()
      const doc = s.categories.find((c) => c.id === id && alive(c))
      if (!doc) throw new RepositoryError('NOT_FOUND', '分类不存在')

      const name = patch.name === undefined ? doc.name : String(patch.name).trim()
      if (!name) throw new RepositoryError('EMPTY_NAME', '请输入分类名称')
      if (name.length > NAME_MAX_LENGTH) {
        throw new RepositoryError('NAME_TOO_LONG', `分类名称最多 ${NAME_MAX_LENGTH} 个字`)
      }
      const duplicated = s.categories.some(
        (c) =>
          alive(c) &&
          c.id !== id &&
          c.name === name &&
          c.type === doc.type &&
          (c.parentId || null) === (doc.parentId || null)
      )
      if (duplicated) throw new RepositoryError('DUPLICATE_NAME', '分类名称已存在')

      Object.assign(doc, patch, { name, updatedAt: now() })
      persist()
      enqueue(COLLECTIONS.CATEGORY, 'update', doc.id, { ...doc })
      return { ...doc }
    },

    /** 删除分类；cascade=true 时连带删除其二级分类 */
    async remove(id, { cascade = true } = {}) {
      const s = await ready()
      const doc = s.categories.find((c) => c.id === id && alive(c))
      if (!doc) throw new RepositoryError('NOT_FOUND', '分类不存在')
      const ts = now()
      doc.deleted = 1
      doc.updatedAt = ts
      enqueue(COLLECTIONS.CATEGORY, 'delete', doc.id, { ...doc })

      if (cascade && !doc.parentId) {
        s.categories
          .filter((c) => c.parentId === id && alive(c))
          .forEach((child) => {
            child.deleted = 1
            child.updatedAt = ts
            enqueue(COLLECTIONS.CATEGORY, 'delete', child.id, { ...child })
          })
      }
      persist()
      return { id }
    },

    /** 拖拽排序预留接口 */
    async reorder(orderedIds) {
      const s = await ready()
      orderedIds.forEach((id, index) => {
        const doc = s.categories.find((c) => c.id === id)
        if (doc) {
          doc.order = index
          doc.updatedAt = now()
        }
      })
      persist()
      return orderedIds
    }
  }

  /* ---------------- 账单 ---------------- */

  const billApi = {
    /**
     * @param {{ledgerId?:string, month?:string, from?:string, to?:string, date?:string,
     *          type?:string, categoryId?:string, keyword?:string, order?:'asc'|'desc'}} query
     * from / to 为 'YYYY-MM-DD'（含首尾），与 month 同时传入时按 AND 处理
     */
    async list(query = {}) {
      const s = await ready()
      return filterBills(s.bills, s.categories, query)
    },

    /** 按日期分组的账单（账单页流水视图） */
    async listGrouped(query = {}) {
      return groupBillsByDate(await this.list(query))
    },

    async get(id) {
      const s = await ready()
      const bill = findBill(id)
      return bill ? decorateBill(bill, lookupOf(s)) : null
    },

    async create(payload) {
      const s = await ready()
      const amount = round2(payload.amount)
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new RepositoryError('INVALID_AMOUNT', '请输入有效的金额')
      }
      const category = payload.categoryId ? findCategory(payload.categoryId) : null
      const primaryId = category
        ? category.parentId || category.id
        : payload.primaryCategoryId || null

      const doc = {
        id: uid('bill'),
        ledgerId: payload.ledgerId,
        type: payload.type || 'expense',
        amount,
        categoryId: category ? category.id : null,
        primaryCategoryId: primaryId,
        remark: String(payload.remark || '').trim(),
        date: payload.date || todayKey(),
        noReimburse: !!payload.noReimburse,
        createdAt: now(),
        updatedAt: now(),
        deleted: 0,
        version: 1
      }
      s.bills.push(doc)
      persist()
      enqueue(COLLECTIONS.BILL, 'create', doc.id, { ...doc })
      return decorateBill(doc, lookupOf(s))
    },

    async update(id, patch) {
      const s = await ready()
      const doc = s.bills.find((b) => b.id === id && alive(b))
      if (!doc) throw new RepositoryError('NOT_FOUND', '账单不存在')

      const next = { ...patch }
      if (next.amount !== undefined) {
        const amount = round2(next.amount)
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new RepositoryError('INVALID_AMOUNT', '请输入有效的金额')
        }
        next.amount = amount
      }
      if (next.categoryId !== undefined) {
        const category = next.categoryId ? findCategory(next.categoryId) : null
        next.categoryId = category ? category.id : null
        next.primaryCategoryId = category
          ? category.parentId || category.id
          : doc.primaryCategoryId
      }
      if (next.remark !== undefined) next.remark = String(next.remark).trim()

      Object.assign(doc, next, { updatedAt: now(), version: (doc.version || 1) + 1 })
      persist()
      enqueue(COLLECTIONS.BILL, 'update', doc.id, { ...doc })
      return decorateBill(doc, lookupOf(s))
    },

    async remove(id) {
      const s = await ready()
      const doc = s.bills.find((b) => b.id === id && alive(b))
      if (!doc) throw new RepositoryError('NOT_FOUND', '账单不存在')
      doc.deleted = 1
      doc.updatedAt = now()
      persist()
      enqueue(COLLECTIONS.BILL, 'delete', doc.id, { ...doc })
      return { id }
    },

    /**
     * 区间汇总（首页 / 账单页结余卡片）
     * 用 month 传月度区间，或用 from / to 传任意区间（账单页按年筛选）
     */
    async summary(query = {}) {
      const s = await ready()
      return summarizeBills(s.bills, query)
    },

    /** 某天的收支汇总（日历视图） */
    async dailySummary(query = {}) {
      return dailySummaryOf(await this.list({ ...query, order: 'asc' }))
    },

    /** 全账本最近 N 条（首页今日账单） */
    async recent(query = {}) {
      return this.list({ ...query, order: 'desc' })
    },

    /**
     * 某分类下的历史备注（记账页「填写备注」的候选）
     * @param {{ledgerId?:string, categoryId:string, limit?:number}} query
     * @returns {Promise<string[]>}
     */
    async remarkHistory(query = {}) {
      const s = await ready()
      return remarkHistoryOf(s.bills, query)
    }
  }

  /* ---------------- 同步（预留） ---------------- */

  const syncApi = {
    async pendingCount() {
      return outbox.pendingCount()
    },
    /** TODO(第二阶段)：接入云端后实现真实推送 */
    async push() {
      return { pushed: 0, pending: outbox.pendingCount() }
    },
    /** TODO(第二阶段)：接入云端后实现增量拉取 */
    async pull() {
      return { updated: 0 }
    },
    subscribe() {
      return () => {}
    }
  }

  return {
    name: 'mock',
    ledger: ledgerApi,
    category: categoryApi,
    bill: billApi,
    sync: syncApi,
    /** 仅调试用：清空本地数据并重新播种 */
    async reset() {
      state = { schemaVersion: SCHEMA_VERSION, ...buildSeed() }
      persist()
      outbox.clear()
      return true
    },
    /** 仅调试用：直接读取内部状态 */
    snapshot() {
      return load()
    }
  }
}
