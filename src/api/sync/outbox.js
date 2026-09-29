/**
 * 增量同步队列（outbox）
 * ------------------------------------------------------------
 * 像寄信：本地写入（create / update / delete）先把信投进本地信箱，
 * syncEngine（邮递员）负责送出去。没网的时候信就在信箱里等着，
 * 联网后一次补推 —— 这就是「本地优先」的全部秘密。
 *
 * 相对第一阶段的三点变化：
 *   1) 存在哪里由**存储后端**决定（见 outboxStore.js）：
 *      idb 数据源落 IndexedDB 的 outbox 表（与业务数据同库），
 *      mock 数据源落内存。队列与业务数据不再各用一套持久化语义。
 *   2) 所有方法都变成 async —— IndexedDB 是异步的。
 *   3) 入队与变更后会**通知订阅者**。syncEngine 靠这个通知做 debounce 调度，
 *      于是适配器不需要 import syncEngine，依赖方向保持单向
 *      （适配器 → outbox ← syncEngine）。
 *
 * 条目结构见 contract.js 的 OutboxEntry；`retry` 会持久化，
 * 所以刷新页面后重试计数不丢。
 */

import { toPlain } from '../core/idb.js'
import { now, uid } from '../../utils/id.js'

export function createOutbox(store) {
  if (!store || typeof store.all !== 'function') {
    throw new Error('[ledger] createOutbox 需要一个存储后端，见 sync/outboxStore.js')
  }

  const listeners = new Set()

  function notify() {
    listeners.forEach((cb) => {
      try {
        cb()
      } catch (e) {
        /* 订阅者的异常不该影响入队本身 */
      }
    })
  }

  async function all() {
    await store.prepare?.()
    return store.all()
  }

  /** 还没送出去的信 */
  async function pending() {
    return (await all()).filter((e) => !e.synced)
  }

  async function pendingCount() {
    return (await pending()).length
  }

  async function enqueue(entry) {
    const row = { retry: 0, synced: false, ...toPlain(entry) }
    if (!row.id) row.id = uid('ob')
    if (!row.ts) row.ts = now()
    await store.prepare?.()
    await store.put([row])
    notify()
    return row
  }

  /**
   * 批量入队。
   * 首次绑定要一次性投递本地已有数据（本项目是 1 账本 + 42 分类 + 44 账单），
   * 逐条 enqueue 会开几十次事务、通知几十次，白白拖慢启动；这里合成一次写、一次通知。
   */
  async function enqueueMany(entries) {
    const list = (entries || []).map((entry) => {
      const row = { retry: 0, synced: false, ...toPlain(entry) }
      if (!row.id) row.id = uid('ob')
      if (!row.ts) row.ts = now()
      return row
    })
    if (!list.length) return []
    await store.prepare?.()
    await store.put(list)
    notify()
    return list
  }

  async function markSynced(ids) {
    const set = new Set(ids || [])
    if (!set.size) return 0
    const rows = (await all()).filter((e) => set.has(e.id))
    if (!rows.length) return 0
    await store.put(rows.map((e) => ({ ...e, synced: true })))
    notify()
    return rows.length
  }

  async function bumpRetry(id) {
    const row = (await all()).find((e) => e.id === id)
    if (!row) return 0
    const next = { ...row, retry: (row.retry || 0) + 1 }
    await store.put([next])
    return next.retry
  }

  /** 整轮同步失败时给全部待推条目 +1（用来观察「这条卡了多久」） */
  async function bumpRetryAll() {
    const rows = await pending()
    if (!rows.length) return 0
    await store.put(rows.map((e) => ({ ...e, retry: (e.retry || 0) + 1 })))
    return rows.length
  }

  /**
   * 永久移除条目。
   * 用途：该条目的版本已被云端否决（云端更新），本地已采纳云端版本 ——
   * 再推上去就是把正确的版本改回旧的。
   */
  async function drop(ids) {
    const list = Array.from(ids || [])
    if (!list.length) return 0
    const removed = await store.remove(list)
    if (removed) notify()
    return removed
  }

  /** 压缩队列：把已同步的条目清掉（否则队列会无限长下去） */
  async function compact() {
    const rows = await all()
    const done = rows.filter((e) => e.synced).map((e) => e.id)
    if (!done.length) return 0
    const removed = await store.remove(done)
    notify()
    return removed
  }

  async function clear() {
    await store.prepare?.()
    await store.clear()
    notify()
    return true
  }

  /** 订阅队列变更；返回取消订阅的函数 */
  function onChange(cb) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }

  return {
    store,
    all,
    pending,
    pendingCount,
    enqueue,
    enqueueMany,
    markSynced,
    bumpRetry,
    bumpRetryAll,
    drop,
    compact,
    clear,
    onChange
  }
}
