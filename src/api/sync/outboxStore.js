/**
 * outbox 的存储后端
 * ------------------------------------------------------------
 * 队列存哪里，由这里决定 —— outbox.js 只负责队列语义（入队、标记、压缩），
 * 不关心底层是内存还是 IndexedDB。
 *
 * 两种实现：
 *   memory —— 纯内存。给 mock 数据源与单元测试用，不建库，
 *             保持 mock「纯内存、零持久化」的语义。
 *   idb    —— IndexedDB 的 outbox 表（与业务数据同库）。S1 建库时
 *             就已经把这层表建好了，只是一直没接上。
 *
 * 后端接口（全部 async）：
 *   prepare()     建库 + 一次性把旧 localStorage 队列搬进来（幂等）
 *   all()         读出全部条目
 *   put(list)     批量 upsert
 *   remove(ids)   批量删除
 *   clear()       清空
 */

import {
  DB_NAME,
  DB_VERSION,
  LEGACY_OUTBOX_KEY,
  META_KEYS,
  STORES,
  clearStore,
  openDB,
  putMany,
  readAll,
  readMeta,
  removeMany,
  toPlain,
  writeMeta
} from '../core/idb.js'
import { now } from '../../utils/id.js'

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** 读第一阶段留在 localStorage 的队列（损坏或格式不对时返回空数组） */
function readLegacyOutbox() {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(LEGACY_OUTBOX_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e) => e && e.id)
  } catch (e) {
    return []
  }
}

/** 纯内存后端（mock 数据源与测试用） */
export function createMemoryOutboxStore(initial = []) {
  let rows = initial.map(toPlain)

  return {
    name: 'memory',

    async prepare() {
      return { imported: 0 }
    },

    async all() {
      return rows.map((r) => ({ ...r })).sort(byId)
    },

    async put(list) {
      const incoming = new Map((list || []).map((e) => [e.id, toPlain(e)]))
      const kept = rows.filter((r) => !incoming.has(r.id))
      rows = [...kept, ...incoming.values()].sort(byId)
      return incoming.size
    },

    async remove(ids) {
      const set = new Set(ids || [])
      const before = rows.length
      rows = rows.filter((r) => !set.has(r.id))
      return before - rows.length
    },

    async clear() {
      rows = []
      return true
    },

    /** 仅测试/调试用：偷看内存里的原始行 */
    _rows() {
      return rows.map((r) => ({ ...r }))
    }
  }
}

/**
 * IndexedDB 后端。
 * 首次 prepare 时会做一次「队列搬迁」：把第一阶段留在 localStorage 的
 * `ledger.outbox.v1` 导入 outbox 表。
 *
 * 两条与 S1 接管旧库一致的策略：
 *   1) 导入后**不删**旧键，留作回退；
 *   2) 靠 meta 标记（`outboxImported`）保证只导入一次 ——
 *      不能靠「旧键是否为空」判断，否则用户重置演示数据后会被再导入一遍。
 */
export function createIdbOutboxStore({ dbName = DB_NAME, version = DB_VERSION } = {}) {
  let dbPromise = null
  let prepared = null

  const getDB = () => (dbPromise ||= openDB({ dbName, version }))

  async function prepare() {
    if (prepared) return prepared
    prepared = (async () => {
      const db = await getDB()
      const meta = await readMeta(db)
      if (meta[META_KEYS.OUTBOX_IMPORTED]) return { imported: 0, alreadyDone: true }

      const legacy = readLegacyOutbox()
      if (legacy.length) await putMany(db, STORES.OUTBOX, legacy)

      // 无论旧队列是否为空都写标记：标记的是「这件事做过了」
      await writeMeta(db, { [META_KEYS.OUTBOX_IMPORTED]: now() })
      return { imported: legacy.length, alreadyDone: false }
    })()
    return prepared
  }

  async function all() {
    const db = await getDB()
    return (await readAll(db, STORES.OUTBOX)).sort(byId)
  }

  return {
    name: 'idb',
    prepare,
    all,

    async put(list) {
      const db = await getDB()
      return putMany(db, STORES.OUTBOX, list)
    },

    async remove(ids) {
      const db = await getDB()
      return removeMany(db, STORES.OUTBOX, ids)
    },

    async clear() {
      const db = await getDB()
      return clearStore(db, STORES.OUTBOX)
    },

    /** 仅调试用 */
    async _count() {
      return (await all()).length
    }
  }
}
