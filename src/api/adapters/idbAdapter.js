import { COLLECTIONS, NAME_MAX_LENGTH, RepositoryError, SCHEMA_VERSION } from '../contract.js'
import { createOutbox } from '../sync/outbox.js'
import { createIdbOutboxStore } from '../sync/outboxStore.js'
import { buildSeed } from '../mock/seed.js'
import { migrateSeedData } from '../core/migrate.js'
import { partitionRemote } from '../core/merge.js'
import {
  DB_NAME,
  DB_VERSION,
  LEGACY_DB_KEY,
  META_KEYS,
  STORES,
  clearStore as idbClearStore,
  createIdbKeyValue,
  openDB,
  putMany as idbPutMany,
  readAll as idbReadAll,
  readMeta as idbReadMeta,
  readOne as idbReadOne,
  writeMeta as idbWriteMeta
} from '../core/idb.js'
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
 *  1) 业务规则不在这里重写一遍。过滤、排序、聚合、派生字段、种子迁移、远端合并
 *     全部来自 core/ 目录（query.js / migrate.js / merge.js），与 mockAdapter
 *     共用同一份实现，从构造上杜绝「两个适配器行为漂移」。
 *
 *  2) 读写分两次事务：先读（readAll）→ 纯 JS 计算 → 再写（putMany）。
 *     IndexedDB 的事务在跨 task 的 await 之后会失效，把「读-改-写」塞进一个
 *     事务里很容易踩 TransactionInactiveError；页面内操作是单线程串行的，
 *     不存在并发写入，因此这里用「读一次、写一次」换取可靠与可读。
 *     （同源多标签页同时写同一条属于未覆盖场景，接云端后由 updatedAt 新者胜兜底。）
 *
 *  3) 查询用 readAll 把集合读进内存再算。个人记账的数据量（千条级）下
 *     getAll 是毫秒级。
 *
 *  4) **同步队列与业务数据同库**。S1 时 outbox 还在 localStorage，S2 把它
 *     搬进了 IndexedDB 的 outbox 表 —— 同一个库、同一套事务语义、同一份备份，
 *     不用再操心「两套存储各自什么时候丢」。
 *
 *  5) 首次使用会**接管第一阶段留在 localStorage 里的数据**（见 LEGACY_DB_KEY），
 *     导入后不删除旧库，留作回退；导入只做一次，靠 meta 标记判断。
 *
 *  6) 真正的推送/拉取不在这里，而在 sync/syncEngine.js。适配器只做两件事：
 *     写的时候把改动 `enqueue` 进队列（**先落数据、再入队**），
 *     以及给引擎提供一个「读一条 / 写回一批」的本地读写口（`syncStore`）。
 *     同步是跨集合、跨存储的行为，不属于某个适配器。
 */

export { STORES, openDB }

const LEGACY_KEY = LEGACY_DB_KEY

/**
 * @returns 与 mockAdapter 同契约的适配器实例
 */
export function createIdbAdapter(options = {}) {
  const { dbName = DB_NAME, version = DB_VERSION, seed = true } = options

  let dbPromise = null
  let initPromise = null

  const getDB = () => (dbPromise ||= openDB({ dbName, version }))

  /** 队列与业务数据同库；换账号时只需把 dbName 换掉即可实现分区（见 S5） */
  const outbox = createOutbox(createIdbOutboxStore({ dbName, version }))
  /** 键值仓，syncEngine 用它存水位线 */
  const kv = createIdbKeyValue(getDB())

  /* ---------------- 底层读写（薄包装，绑定本实例的 db） ---------------- */

  const readAll = (storeName) => getDB().then((db) => idbReadAll(db, storeName))
  const readOne = (storeName, key) => getDB().then((db) => idbReadOne(db, storeName, key))
  const putMany = (storeName, docs) => getDB().then((db) => idbPutMany(db, storeName, docs))
  const clearStore = (storeName) => getDB().then((db) => idbClearStore(db, storeName))
  const readMeta = () => getDB().then((db) => idbReadMeta(db))
  const writeMeta = (patch) => getDB().then((db) => idbWriteMeta(db, patch))

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
    const seedMeta = meta[META_KEYS.SEED] || {}
    const bills = await readAll(STORES.BILL)
    const result = migrateSeedData(bills, seedMeta)
    if (result.changed) {
      await putMany(STORES.BILL, [...result.added, ...result.updated])
      await writeMeta({ [META_KEYS.SEED]: seedMeta })
    }
    return result.changed
  }

  async function init() {
    await getDB()
    const meta = await readMeta()

    if (meta[META_KEYS.SCHEMA] !== SCHEMA_VERSION) {
      // 已经接管过一次就不再接管：否则用户点过「重置演示数据」后，
      // 旧库又会被重新导入一遍，把重置结果覆盖掉
      const legacy = meta[META_KEYS.IMPORTED] ? null : readLegacy()

      if (legacy) {
        await putMany(STORES.LEDGER, legacy.ledgers)
        await putMany(STORES.CATEGORY, legacy.categories)
        await putMany(STORES.BILL, legacy.bills)
        await writeMeta({ [META_KEYS.SEED]: legacy.meta, [META_KEYS.IMPORTED]: now() })
      } else if (seed) {
        const seedData = buildSeed()
        await putMany(STORES.LEDGER, seedData.ledgers)
        await putMany(STORES.CATEGORY, seedData.categories)
        await putMany(STORES.BILL, seedData.bills)
        await writeMeta({ [META_KEYS.SEED]: seedData.meta || {} })
      }
      await writeMeta({ [META_KEYS.SCHEMA]: SCHEMA_VERSION })
    }

    // 队列搬迁（旧 localStorage → IndexedDB）在这里顺带做完，
    // 幂等标记由 outboxStore 负责
    await outbox.store.prepare?.()

    // 演示数据迁移：seed=false（测试用的空库）时必须跳过，
    // 否则 migrateSeedData 会把演示账单当成「缺失的补充数据」补进来
    if (seed) await runSeedMigration()
    return true
  }

  /** 所有对外方法都先 await 它，保证「建库 → 接管/播种 → 迁移」只跑一次 */
  function ready() {
    if (!initPromise) initPromise = init()
    return initPromise
  }

  /**
   * 入队。
   * 刻意 try/catch 掉：**绝不能因为队列写不进去而让用户的账白记** ——
   * 数据已经落库了，同步晚一轮是小事，丢一笔账是大事。
   */
  async function enqueue(collection, op, docId, payload) {
    try {
      await outbox.enqueue({
        id: uid('ob'),
        collection,
        op,
        docId,
        payload,
        ts: now()
      })
    } catch (e) {
      console.error('[ledger] 同步队列写入失败，该条改动本轮不会上云', e)
    }
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
      await enqueue(COLLECTIONS.LEDGER, 'update', id, { ...next })
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
      await enqueue(COLLECTIONS.CATEGORY, 'create', doc.id, { ...doc })
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
      await enqueue(COLLECTIONS.CATEGORY, 'update', next.id, { ...next })
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

      if (cascade && !doc.parentId) {
        categories
          .filter((c) => c.parentId === id && alive(c))
          .forEach((child) => {
            touched.push({ ...child, deleted: 1, updatedAt: ts })
          })
      }

      await putMany(STORES.CATEGORY, touched)
      await Promise.all(
        touched.map((item) => enqueue(COLLECTIONS.CATEGORY, 'delete', item.id, { ...item }))
      )
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
      await enqueue(COLLECTIONS.BILL, 'create', doc.id, { ...doc })
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
      await enqueue(COLLECTIONS.BILL, 'update', merged.id, { ...merged })
      return decorateBill(merged, createCategoryLookup(categories))
    },

    async remove(id) {
      await ready()
      const doc = await readOne(STORES.BILL, id)
      if (!doc || !alive(doc)) throw new RepositoryError('NOT_FOUND', '账单不存在')
      const next = { ...doc, deleted: 1, updatedAt: now() }
      await putMany(STORES.BILL, [next])
      await enqueue(COLLECTIONS.BILL, 'delete', next.id, { ...next })
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

  /* ---------------- 同步 ---------------- */

  /**
   * 队列状态查询。真正的推送/拉取在 sync/syncEngine.js ——
   * 适配器只负责「写的时候把改动放进队列」。
   */
  const syncApi = {
    async pendingCount() {
      return outbox.pendingCount()
    },
    /** 仅调试用 */
    async clearOutbox() {
      await outbox.clear()
      return true
    }
  }

  /** 集合名 → objectStore 名 */
  const STORE_OF = {
    [COLLECTIONS.LEDGER]: STORES.LEDGER,
    [COLLECTIONS.CATEGORY]: STORES.CATEGORY,
    [COLLECTIONS.BILL]: STORES.BILL
  }

  /**
   * 给 syncEngine 用的本地读写口（不挂在契约上，也不属于视图层的依赖）。
   * 引擎只知道「读一条文档」「把远端增量写回本地」，不关心底层是 IndexedDB。
   */
  const syncStore = {
    async get(collection, id) {
      await ready()
      const name = STORE_OF[collection]
      if (!name) return null
      return readOne(name, id)
    },

    /** 读某个集合的全部本地文档。首次绑定要把它们整体入队推上云 */
    async all(collection) {
      await ready()
      const name = STORE_OF[collection]
      if (!name) return []
      return readAll(name)
    },

    /**
     * 把远端增量合并进本地。
     * `clockOffset`（S4-2）= 服务端时间 - 本地时间，用来把两边的 `updatedAt`
     * 换算到服务端时间轴上比较。引擎只在服务端时间可信时才传非 0 值。
     */
    async applyRemote(collection, docs, clockOffset = 0) {
      await ready()
      const name = STORE_OF[collection]
      if (!name || !docs || !docs.length) return { applied: 0, kept: 0 }
      const locals = await readAll(name)
      // 新者胜：远端更新才覆盖，本地更新的保留（它还在 outbox 里等下一轮推送）
      const { take, keep } = partitionRemote(locals, docs, clockOffset)
      if (take.length) await putMany(name, take)
      return { applied: take.length, kept: keep.length }
    },

    /**
     * 把服务端盖的裁决刻度写回本地副本（S4-6）。
     *
     * `stamps`：`{ [本地id]: 服务端刻度 }`。只更新 `serverUpdatedAt` 一个字段。
     *
     * ⚠️ **不走写路径、不入 outbox**：这是服务端元数据，不是用户内容。
     *    入队会自己推自己，而且刻度只能由服务端生成，推上去也会被覆盖。
     *    `updatedAt` 也**不动** —— 那是内容版本（客户端时钟），保持原样。
     *
     * ⚠️ 文档可能已被本地再次修改（`updatedAt` 晚于刻度）—— 那没关系，
     *    写入后 `effectiveServerStamp` 会判定该刻度失效并退回 `updatedAt`，
     *    不会把新内容误判成旧内容。这里不做判断，判断只留在裁决那一处。
     *
     * 写入前 `toPlain()`：结构化克隆处理不了 Vue 的 Proxy（见本文件上方说明）。
     */
    async applyStamps(collection, stamps) {
      await ready()
      const name = STORE_OF[collection]
      if (!name || !stamps) return 0
      const ids = Object.keys(stamps)
      if (!ids.length) return 0
      const existing = await readAll(name)
      const byId = new Map(existing.map((d) => [d.id, d]))
      const next = []
      for (const id of ids) {
        const doc = byId.get(id)
        if (!doc) continue
        const stamp = Number(stamps[id])
        if (!Number.isFinite(stamp) || stamp <= 0) continue
        next.push({ ...doc, serverUpdatedAt: stamp })
      }
      if (next.length) await putMany(name, next)
      return next.length
    }
  }

  return {
    name: 'idb',
    ledger: ledgerApi,
    category: categoryApi,
    bill: billApi,
    sync: syncApi,
    /** 同步队列实例（syncEngine 与调试面板用） */
    outbox,
    /** 给 syncEngine 的本地读写口 */
    syncStore,
    /** 键值仓（syncEngine 存水位线用） */
    kv,
    /** 建库 + 接管/播种 + 迁移（切换数据源后可显式 await，确认一切就绪） */
    ready,

    /** 仅调试用：清空 IndexedDB 并重新播种（「我的 → 重置演示数据」） */
    async reset() {
      await getDB()
      const meta = await readMeta()

      // 保留两个「已经导入过了」的标记：重置应该得到干净的演示数据，
      // 而不是把 localStorage 里的旧数据（旧库 / 旧队列）又导入一遍
      const kept = {}
      ;[META_KEYS.IMPORTED, META_KEYS.OUTBOX_IMPORTED].forEach((key) => {
        if (meta[key]) kept[key] = meta[key]
      })

      await clearStore(STORES.LEDGER)
      await clearStore(STORES.CATEGORY)
      await clearStore(STORES.BILL)
      await clearStore(STORES.META)
      await outbox.clear()

      if (Object.keys(kept).length) await writeMeta(kept)
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
        meta: meta[META_KEYS.SEED] || {}
      }
    }
  }
}
