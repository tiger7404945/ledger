import { COLLECTIONS, NAME_MAX_LENGTH, RepositoryError, SCHEMA_VERSION } from '../contract.js'
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

/**
 * IndexedDB 适配器（第二阶段 · 本地离线缓存）
 * ------------------------------------------------------------
 * 与 mockAdapter 实现**同一套契约**（见 contract.js），切换方式只有一处：
 *
 *   // src/api/index.js
 *   export const DATA_SOURCE = 'idb'
 *
 * 设计取舍（为什么这么写）：
 *
 *  1) 业务规则不在这里重写一遍。过滤、排序、聚合、派生字段、种子迁移全部来自
 *     core/query.js 与 core/migrate.js，与 mockAdapter 共用同一份实现，
 *     从构造上杜绝「两个适配器行为漂移」。
 *
 *  2) 读写分两次事务：先读（readAll）→ 纯 JS 计算 → 再写（putMany）。
 *     IndexedDB 的事务在跨 task 的 await 之后会失效，把「读-改-写」塞进一个
 *     事务里很容易踩 TransactionInactiveError；页面内操作是单线程串行的，
 *     不存在并发写入，因此这里用「读一次、写一次」换取可靠与可读。
 *     （同源多标签页同时写同一条属于未覆盖场景，第二阶段接云端时由
 *       updatedAt 新者胜兜底。）
 *
 *  3) 查询用 readAll 把集合读进内存再算。个人记账的数据量（千条级）下
 *     getAll 是毫秒级；outbox 队列仍在 localStorage（与 mockAdapter 一致），
 *     第二阶段接云端时再一起搬进 IndexedDB 的 outbox 表。
 *
 *  4) 首次使用会**接管第一阶段留在 localStorage 里的数据**（见 LEGACY_KEY），
 *     导入后不删除旧库，留作回退；导入只做一次，靠 meta 标记判断。
 */

const DB_NAME = 'ledger'
const DB_VERSION = 2
const LEGACY_KEY = 'ledger.db.v1'

export const STORES = {
  LEDGER: 'ledger',
  CATEGORY: 'category',
  BILL: 'bill',
  OUTBOX: 'outbox',
  META: 'meta'
}

/** meta 表的键 */
const META_SCHEMA = 'schemaVersion'
const META_SEED = 'seedMeta'
const META_IMPORTED = 'importedFromLocalStorage'

/**
 * 写入前做一次 JSON 深拷贝。
 * 目的：IndexedDB 用结构化克隆存数据，而 Vue 的响应式对象是 Proxy，
 * 直接 put 会抛 DataCloneError（新手最常踩的坑之一）。本适配器存储的都是
 * JSON 安全的原始类型，深拷贝一次即可彻底免疫，代价可忽略。
 */
const toPlain = (doc) => JSON.parse(JSON.stringify(doc))

/** 打开数据库（含建库与索引；已存在则直接复用） */
export function openDB({ dbName = DB_NAME, version = DB_VERSION } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('[ledger] 当前环境不支持 IndexedDB'))
      return
    }
    const req = indexedDB.open(dbName, version)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORES.LEDGER)) {
        db.createObjectStore(STORES.LEDGER, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORES.CATEGORY)) {
        const store = db.createObjectStore(STORES.CATEGORY, { keyPath: 'id' })
        store.createIndex('ledgerId', 'ledgerId')
        store.createIndex('parentId', 'parentId')
        store.createIndex('type', 'type')
        store.createIndex('updatedAt', 'updatedAt')
      }
      if (!db.objectStoreNames.contains(STORES.BILL)) {
        const store = db.createObjectStore(STORES.BILL, { keyPath: 'id' })
        store.createIndex('ledgerId', 'ledgerId')
        store.createIndex('date', 'date')
        store.createIndex('month', 'month')
        store.createIndex('categoryId', 'categoryId')
        store.createIndex('updatedAt', 'updatedAt')
      }
      if (!db.objectStoreNames.contains(STORES.OUTBOX)) {
        const store = db.createObjectStore(STORES.OUTBOX, { keyPath: 'id' })
        store.createIndex('synced', 'synced')
      }
      if (!db.objectStoreNames.contains(STORES.META)) {
        db.createObjectStore(STORES.META, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () =>
      reject(new Error('[ledger] 数据库升级被其它标签页占用，请关闭其它页签后重试'))
  })
}

/**
 * @returns 与 mockAdapter 同契约的适配器实例
 */
export function createIdbAdapter(options = {}) {
  const { dbName = DB_NAME, version = DB_VERSION } = options

  let dbPromise = null
  let initPromise = null

  const getDB = () => (dbPromise ||= openDB({ dbName, version }))

  /* ---------------- 底层读写 ---------------- */

  function readAll(storeName) {
    return getDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll()
          req.onsuccess = () => resolve(req.result || [])
          req.onerror = () => reject(req.error)
        })
    )
  }

  function readOne(storeName, key) {
    return getDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key)
          req.onsuccess = () => resolve(req.result || null)
          req.onerror = () => reject(req.error)
        })
    )
  }

  /** 批量 upsert（一个事务内写完，要么都成功要么都不写） */
  function putMany(storeName, docs) {
    if (!docs || !docs.length) return Promise.resolve(0)
    return getDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readwrite')
          const store = tx.objectStore(storeName)
          docs.forEach((doc) => store.put(toPlain(doc)))
          tx.oncomplete = () => resolve(docs.length)
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error || new Error('[ledger] 写入事务被中止'))
        })
    )
  }

  function clearStore(storeName) {
    return getDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readwrite')
          tx.objectStore(storeName).clear()
          tx.oncomplete = () => resolve(true)
          tx.onerror = () => reject(tx.error)
        })
    )
  }

  async function readMeta() {
    const rows = await readAll(STORES.META)
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  }

  function writeMeta(patch) {
    return putMany(
      STORES.META,
      Object.entries(patch).map(([key, value]) => ({ key, value }))
    )
  }

  /* ---------------- 初始化：接管旧数据 / 播种 / 迁移 ---------------- */

  /** 读取第一阶段留在 localStorage 里的库（读取失败或版本不符时返回 null） */
  function readLegacy() {
    if (typeof localStorage === 'undefined') return null
    try {
      const raw = localStorage.getItem(LEGACY_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw)
      if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION) return null
      if (!Array.isArray(parsed.bills) || !Array.isArray(parsed.categories)) return null
      return {
        ledgers: parsed.ledgers || [],
        categories: parsed.categories,
        bills: parsed.bills,
        meta: parsed.meta || {}
      }
    } catch (e) {
      return null
    }
  }

  /** 幂等的演示数据迁移（规则见 core/migrate.js），只写回有变化的部分 */
  async function runSeedMigration() {
    const meta = await readMeta()
    const seedMeta = meta[META_SEED] || {}
    const bills = await readAll(STORES.BILL)
    const result = migrateSeedData(bills, seedMeta)
    if (result.changed) {
      await putMany(STORES.BILL, [...result.added, ...result.updated])
      await writeMeta({ [META_SEED]: seedMeta })
    }
    return result.changed
  }

  async function init() {
    await getDB()
    const meta = await readMeta()

    if (meta[META_SCHEMA] !== SCHEMA_VERSION) {
      // 已经接管过一次就不再接管：否则用户点过「重置演示数据」后，
      // 旧库又会被重新导入一遍，把重置结果覆盖掉
      const legacy = meta[META_IMPORTED] ? null : readLegacy()

      if (legacy) {
        await putMany(STORES.LEDGER, legacy.ledgers)
        await putMany(STORES.CATEGORY, legacy.categories)
        await putMany(STORES.BILL, legacy.bills)
        await writeMeta({ [META_SEED]: legacy.meta, [META_IMPORTED]: now() })
      } else {
        const seed = buildSeed()
        await putMany(STORES.LEDGER, seed.ledgers)
        await putMany(STORES.CATEGORY, seed.categories)
        await putMany(STORES.BILL, seed.bills)
        await writeMeta({ [META_SEED]: seed.meta || {} })
      }
      await writeMeta({ [META_SCHEMA]: SCHEMA_VERSION })
    }

    await runSeedMigration()
    return true
  }

  /** 所有对外方法都先 await 它，保证「建库 → 接管/播种 → 迁移」只跑一次 */
  function ready() {
    if (!initPromise) initPromise = init()
    return initPromise
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

  /* ---------------- 账本 ---------------- */

  const ledgerApi = {
    async list() {
      await ready()
      return (await readAll(STORES.LEDGER)).map((l) => ({ ...l }))
    },

    async get(id) {
      await ready()
      const item = await readOne(STORES.LEDGER, id)
      return item ? { ...item } : null
    },

    async update(id, patch) {
      await ready()
      const item = await readOne(STORES.LEDGER, id)
      if (!item) throw new RepositoryError('NOT_FOUND', '账本不存在')
      const next = { ...item, ...patch, updatedAt: now() }
      await putMany(STORES.LEDGER, [next])
      enqueue(COLLECTIONS.LEDGER, 'update', id, { ...next })
      return { ...next }
    }
  }

  /* ---------------- 分类 ---------------- */

  const categoryApi = {
    /** @param {{ledgerId?:string, type?:string, parentId?:string|null, includeDeleted?:boolean}} query */
    async list(query = {}) {
      await ready()
      return filterCategories(await readAll(STORES.CATEGORY), query)
    },

    async get(id) {
      await ready()
      const cat = await readOne(STORES.CATEGORY, id)
      return cat && alive(cat) ? { ...cat } : null
    },

    async listChildren(parentId) {
      await ready()
      return filterCategories(await readAll(STORES.CATEGORY), { parentId })
    },

    /**
     * @param {{name:string, icon:string, parentId?:string|null, type:string, ledgerId:string}} payload
     */
    async create(payload) {
      await ready()
      const categories = await readAll(STORES.CATEGORY)

      const name = String(payload.name || '').trim()
      if (!name) throw new RepositoryError('EMPTY_NAME', '请输入分类名称')
      if (name.length > NAME_MAX_LENGTH) {
        throw new RepositoryError('NAME_TOO_LONG', `分类名称最多 ${NAME_MAX_LENGTH} 个字`)
      }

      const parentId = payload.parentId || null
      if (parentId && !categories.some((c) => c.id === parentId && alive(c))) {
        throw new RepositoryError('PARENT_NOT_FOUND', '所属一级分类不存在')
      }

      const duplicated = categories.some(
        (c) =>
          alive(c) &&
          c.name === name &&
          c.type === payload.type &&
          (c.parentId || null) === parentId &&
          c.ledgerId === payload.ledgerId
      )
      if (duplicated) throw new RepositoryError('DUPLICATE_NAME', '分类名称已存在')

      // order 与 mockAdapter 保持一致：同级同类型同账本的下一个序号
      const siblings = categories.filter(
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
      await putMany(STORES.CATEGORY, [doc])
      enqueue(COLLECTIONS.CATEGORY, 'create', doc.id, { ...doc })
      return { ...doc }
    },

    async update(id, patch) {
      await ready()
      const categories = await readAll(STORES.CATEGORY)
      const doc = categories.find((c) => c.id === id && alive(c))
      if (!doc) throw new RepositoryError('NOT_FOUND', '分类不存在')

      const name = patch.name === undefined ? doc.name : String(patch.name).trim()
      if (!name) throw new RepositoryError('EMPTY_NAME', '请输入分类名称')
      if (name.length > NAME_MAX_LENGTH) {
        throw new RepositoryError('NAME_TOO_LONG', `分类名称最多 ${NAME_MAX_LENGTH} 个字`)
      }
      const duplicated = categories.some(
        (c) =>
          alive(c) &&
          c.id !== id &&
          c.name === name &&
          c.type === doc.type &&
          (c.parentId || null) === (doc.parentId || null)
      )
      if (duplicated) throw new RepositoryError('DUPLICATE_NAME', '分类名称已存在')

      const next = { ...doc, ...patch, name, updatedAt: now() }
      await putMany(STORES.CATEGORY, [next])
      enqueue(COLLECTIONS.CATEGORY, 'update', next.id, { ...next })
      return { ...next }
    },

    /** 删除分类；cascade=true 时连带删除其二级分类（软删除） */
    async remove(id, { cascade = true } = {}) {
      await ready()
      const categories = await readAll(STORES.CATEGORY)
      const doc = categories.find((c) => c.id === id && alive(c))
      if (!doc) throw new RepositoryError('NOT_FOUND', '分类不存在')

      const ts = now()
      const touched = [{ ...doc, deleted: 1, updatedAt: ts }]
      enqueue(COLLECTIONS.CATEGORY, 'delete', doc.id, { ...touched[0] })

      if (cascade && !doc.parentId) {
        categories
          .filter((c) => c.parentId === id && alive(c))
          .forEach((child) => {
            const next = { ...child, deleted: 1, updatedAt: ts }
            touched.push(next)
            enqueue(COLLECTIONS.CATEGORY, 'delete', child.id, { ...next })
          })
      }
      await putMany(STORES.CATEGORY, touched)
      return { id }
    },

    /** 拖拽排序预留接口 */
    async reorder(orderedIds) {
      await ready()
      const categories = await readAll(STORES.CATEGORY)
      const ts = now()
      const touched = []
      orderedIds.forEach((id, index) => {
        const doc = categories.find((c) => c.id === id)
        if (doc) touched.push({ ...doc, order: index, updatedAt: ts })
      })
      await putMany(STORES.CATEGORY, touched)
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
      await ready()
      const [bills, categories] = await Promise.all([
        readAll(STORES.BILL),
        readAll(STORES.CATEGORY)
      ])
      return filterBills(bills, categories, query)
    },

    /** 按日期分组的账单（账单页流水视图） */
    async listGrouped(query = {}) {
      return groupBillsByDate(await this.list(query))
    },

    async get(id) {
      await ready()
      const [bill, categories] = await Promise.all([
        readOne(STORES.BILL, id),
        readAll(STORES.CATEGORY)
      ])
      if (!bill || !alive(bill)) return null
      return decorateBill(bill, createCategoryLookup(categories))
    },

    async create(payload) {
      await ready()
      const amount = round2(payload.amount)
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new RepositoryError('INVALID_AMOUNT', '请输入有效的金额')
      }

      const categories = await readAll(STORES.CATEGORY)
      let category = null
      if (payload.categoryId) {
        const found = categories.find((c) => c.id === payload.categoryId && alive(c))
        category = found || null
      }
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
      await putMany(STORES.BILL, [doc])
      enqueue(COLLECTIONS.BILL, 'create', doc.id, { ...doc })
      return decorateBill(doc, createCategoryLookup(categories))
    },

    async update(id, patch) {
      await ready()
      const doc = await readOne(STORES.BILL, id)
      if (!doc || !alive(doc)) throw new RepositoryError('NOT_FOUND', '账单不存在')

      const categories = await readAll(STORES.CATEGORY)
      const next = { ...patch }

      if (next.amount !== undefined) {
        const amount = round2(next.amount)
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new RepositoryError('INVALID_AMOUNT', '请输入有效的金额')
        }
        next.amount = amount
      }
      if (next.categoryId !== undefined) {
        const category = next.categoryId
          ? categories.find((c) => c.id === next.categoryId && alive(c)) || null
          : null
        next.categoryId = category ? category.id : null
        next.primaryCategoryId = category
          ? category.parentId || category.id
          : doc.primaryCategoryId
      }
      if (next.remark !== undefined) next.remark = String(next.remark).trim()

      const merged = {
        ...doc,
        ...next,
        updatedAt: now(),
        version: (doc.version || 1) + 1
      }
      await putMany(STORES.BILL, [merged])
      enqueue(COLLECTIONS.BILL, 'update', merged.id, { ...merged })
      return decorateBill(merged, createCategoryLookup(categories))
    },

    async remove(id) {
      await ready()
      const doc = await readOne(STORES.BILL, id)
      if (!doc || !alive(doc)) throw new RepositoryError('NOT_FOUND', '账单不存在')
      const next = { ...doc, deleted: 1, updatedAt: now() }
      await putMany(STORES.BILL, [next])
      enqueue(COLLECTIONS.BILL, 'delete', next.id, { ...next })
      return { id }
    },

    /**
     * 区间汇总（首页 / 账单页结余卡片）
     * 用 month 传月度区间，或用 from / to 传任意区间（账单页按年筛选）
     */
    async summary(query = {}) {
      await ready()
      return summarizeBills(await readAll(STORES.BILL), query)
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
      await ready()
      return remarkHistoryOf(await readAll(STORES.BILL), query)
    }
  }

  /* ---------------- 同步（第二阶段接云端后实现真实推送/拉取） ---------------- */

  const syncApi = {
    async pendingCount() {
      return outbox.pendingCount()
    },
    async push() {
      return { pushed: 0, pending: outbox.pendingCount() }
    },
    async pull() {
      return { updated: 0 }
    },
    subscribe() {
      return () => {}
    }
  }

  return {
    name: 'idb',
    ledger: ledgerApi,
    category: categoryApi,
    bill: billApi,
    sync: syncApi,
    /** 建库 + 接管/播种 + 迁移（切换数据源后可显式 await，确认一切就绪） */
    ready,

    /** 仅调试用：清空 IndexedDB 并重新播种（「我的 → 重置演示数据」） */
    async reset() {
      await getDB()
      const meta = await readMeta()
      // 保留「已接管旧库」的标记：重置应该得到干净的演示数据，
      // 而不是把 localStorage 里的旧数据又导入一遍
      const keepImported = meta[META_IMPORTED]

      await clearStore(STORES.LEDGER)
      await clearStore(STORES.CATEGORY)
      await clearStore(STORES.BILL)
      await clearStore(STORES.OUTBOX)
      await clearStore(STORES.META)
      outbox.clear()

      if (keepImported) await writeMeta({ [META_IMPORTED]: keepImported })
      initPromise = null
      await ready()
      return true
    },

    /** 仅调试用：读出全部数据（结构对齐 mockAdapter.snapshot） */
    async snapshot() {
      await ready()
      const meta = await readMeta()
      return {
        schemaVersion: SCHEMA_VERSION,
        ledgers: await readAll(STORES.LEDGER),
        categories: await readAll(STORES.CATEGORY),
        bills: await readAll(STORES.BILL),
        meta: meta[META_SEED] || {}
      }
    }
  }
}
