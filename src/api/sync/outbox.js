/**
 * 增量同步队列（outbox）
 * ------------------------------------------------------------
 * 本地写入（create / update / delete）都会入队，标记 synced=false。
 * 后续接入 LeanCloud 时：
 *   1. syncEngine 读取 pending() 的条目；
 *   2. 逐条调用云端 API（幂等：以 docId + updatedAt 为准）；
 *   3. 成功后 markSynced(ids)，失败则 bumpRetry(id) 并指数退避重试。
 */

const STORAGE_KEY = 'ledger.outbox.v1'

function read() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch (e) {
    return []
  }
}

function write(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch (e) {
    /* 忽略配额错误 */
  }
}

export const outbox = {
  /** @param {import('../contract').OutboxEntry} entry */
  enqueue(entry) {
    const list = read()
    list.push({
      retry: 0,
      synced: false,
      ...entry
    })
    write(list)
  },

  all() {
    return read()
  },

  pending() {
    return read().filter((e) => !e.synced)
  },

  pendingCount() {
    return this.pending().length
  },

  markSynced(ids) {
    const set = new Set(ids)
    write(read().map((e) => (set.has(e.id) ? { ...e, synced: true } : e)))
  },

  bumpRetry(id) {
    write(read().map((e) => (e.id === id ? { ...e, retry: (e.retry || 0) + 1 } : e)))
  },

  clear() {
    write([])
  }
}
