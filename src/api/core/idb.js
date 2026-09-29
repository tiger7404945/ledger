/**
 * IndexedDB 底层原语
 * ------------------------------------------------------------
 * 这里只放「与业务无关」的库操作：打开数据库、建 objectStore 与索引，
 * 以及最基础的读写原语。
 *
 * 为什么要单独抽一层：
 *   业务数据（ledger / category / bill）与同步队列（outbox）都要写 IndexedDB。
 *   如果 outbox 去 import idbAdapter，而 idbAdapter 又 import outbox，
 *   就形成循环依赖。把「库本身」抽出来让两边都依赖它，依赖图保持单向。
 *
 * 两条必须遵守的约定（都是踩过的坑）：
 *   1) 写入前必须 toPlain()。IndexedDB 用结构化克隆存数据，而 Vue 的响应式
 *      对象是 Proxy，直接 put 会抛 DataCloneError。
 *   2) 「读-改-写」分两次事务。IndexedDB 的事务在跨 task 的 await 之后会失效，
 *      塞进一个事务里很容易踩 TransactionInactiveError。
 *
 * 另外注意：**存储的返回顺序不是契约**。getAll 按主键序返回，而内存数组是
 * 插入序 —— 凡是有顺序语义的地方，都要显式排序后再用。
 */

export const DB_NAME = 'ledger'
export const DB_VERSION = 2

/** 第一阶段的数据留在 localStorage 的这个键下（接管后不删，留作回退） */
export const LEGACY_DB_KEY = 'ledger.db.v1'
/** 第一阶段的同步队列留在 localStorage 的这个键下（搬迁后同样不删） */
export const LEGACY_OUTBOX_KEY = 'ledger.outbox.v1'

export const STORES = {
  LEDGER: 'ledger',
  CATEGORY: 'category',
  BILL: 'bill',
  OUTBOX: 'outbox',
  META: 'meta'
}

/** meta 表的键（这张表就是个简单的键值仓） */
export const META_KEYS = {
  /** 已落库的数据结构版本 */
  SCHEMA: 'schemaVersion',
  /** 演示数据种子迁移的进度标记 */
  SEED: 'seedMeta',
  /** 是否已从 localStorage 接管过业务数据 */
  IMPORTED: 'importedFromLocalStorage',
  /** 是否已从 localStorage 搬过 outbox 队列 */
  OUTBOX_IMPORTED: 'outboxImported',
  /** 增量拉取的水位线：上次同步到的服务端时间 */
  WATERMARK: 'syncWatermark'
}

/** 见文件头约定 1 */
export const toPlain = (doc) => JSON.parse(JSON.stringify(doc))

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

/* ---------------- 基础读写原语 ---------------- */

export function readAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

export function readOne(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

/** 批量 upsert（一个事务内写完，要么都成功要么都不写） */
export function putMany(db, storeName, docs) {
  if (!docs || !docs.length) return Promise.resolve(0)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    docs.forEach((doc) => store.put(toPlain(doc)))
    tx.oncomplete = () => resolve(docs.length)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('[ledger] 写入事务被中止'))
  })
}

/** 批量删除（outbox 的压缩与作废用） */
export function removeMany(db, storeName, keys) {
  if (!keys || !keys.length) return Promise.resolve(0)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    keys.forEach((key) => store.delete(key))
    tx.oncomplete = () => resolve(keys.length)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('[ledger] 删除事务被中止'))
  })
}

export function clearStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).clear()
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error)
  })
}

/* ---------------- meta 键值仓 ---------------- */

export async function readMeta(db) {
  const rows = await readAll(db, STORES.META)
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

export function writeMeta(db, patch) {
  return putMany(
    db,
    STORES.META,
    Object.entries(patch).map(([key, value]) => ({ key, value }))
  )
}

/** 基于 meta 表的键值仓（syncEngine 用它存水位线） */
export function createIdbKeyValue(dbPromise) {
  return {
    async get(key) {
      const meta = await readMeta(await dbPromise)
      return meta[key]
    },
    async set(key, value) {
      await writeMeta(await dbPromise, { [key]: value })
      return true
    },
    async remove(key) {
      await removeMany(await dbPromise, STORES.META, [key])
      return true
    }
  }
}
