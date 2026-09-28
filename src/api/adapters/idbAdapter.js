import { NotImplementedError } from '../contract.js'
import { outbox } from '../sync/outbox.js'

/**
 * IndexedDB 适配器（第二阶段：本地离线缓存）
 * ------------------------------------------------------------
 * 设计与 mockAdapter 完全一致的对外契约，切换方式：
 *
 *   // src/api/index.js
 *   import { createIdbAdapter } from './adapters/idbAdapter.js'
 *   export const db = createIdbAdapter({ dbName: 'ledger', version: 1 })
 *
 * 实现要点（待补齐）：
 *  1. openDB()：建立 objectStore —— ledger / category / bill / outbox / meta
 *     - category: keyPath 'id'，索引 ledgerId、parentId、type、updatedAt
 *     - bill:     keyPath 'id'，索引 ledgerId、date、month、categoryId、updatedAt
 *  2. 查询：优先走索引（bill 按 date 区间取整月，避免全表扫描）
 *  3. 写入：单个事务内同时写业务表 + outbox 表，保证原子性
 *  4. 同步：与 leancloudAdapter 组合成 syncEngine（pull 合并 / push 推送）
 *  5. 冲突：以 updatedAt 大者胜，version 用于服务端校验
 */

const DB_NAME = 'ledger'
const DB_VERSION = 1
export const STORES = {
  LEDGER: 'ledger',
  CATEGORY: 'category',
  BILL: 'bill',
  OUTBOX: 'outbox'
}

function notReady(method) {
  return async () => {
    throw new NotImplementedError(`idbAdapter.${method}`)
  }
}

/** 打开数据库（骨架实现，可直接用于第二阶段） */
export function openDB({ dbName = DB_NAME, version = DB_VERSION } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new NotImplementedError('IndexedDB'))
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
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/**
 * @returns 与 mockAdapter 同契约的适配器实例
 */
export function createIdbAdapter(options = {}) {
  const { dbName = DB_NAME, version = DB_VERSION, latency = 0 } = options
  void dbName
  void version
  void latency
  void openDB
  void outbox

  return {
    name: 'idb',
    ready: () => openDB({ dbName, version }),
    ledger: {
      list: notReady('ledger.list'),
      get: notReady('ledger.get'),
      update: notReady('ledger.update')
    },
    category: {
      list: notReady('category.list'),
      get: notReady('category.get'),
      create: notReady('category.create'),
      update: notReady('category.update'),
      remove: notReady('category.remove'),
      listChildren: notReady('category.listChildren'),
      reorder: notReady('category.reorder')
    },
    bill: {
      list: notReady('bill.list'),
      listGrouped: notReady('bill.listGrouped'),
      get: notReady('bill.get'),
      create: notReady('bill.create'),
      update: notReady('bill.update'),
      remove: notReady('bill.remove'),
      summary: notReady('bill.summary'),
      dailySummary: notReady('bill.dailySummary'),
      recent: notReady('bill.recent'),
      remarkHistory: notReady('bill.remarkHistory')
    },
    sync: {
      pendingCount: async () => outbox.pendingCount(),
      push: notReady('sync.push'),
      pull: notReady('sync.pull'),
      subscribe: () => () => {}
    }
  }
}
