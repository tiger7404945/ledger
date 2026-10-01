/**
 * 首次绑定裁决（S5-7）
 * ------------------------------------------------------------
 * 名词：「首次绑定」= 某个本地分区**第一次**要和云端建立关系。
 * 为什么需要它：演示种子是直接写进本地库的，**没有经过 outbox**，
 * 不整体入队一次，用户一开始看到的那些账目永远不会上云 ——
 * 于是「清空本地再从云端恢复」这条路根本无从谈起。
 *
 * S3 时期的做法是**本地优先**（无脑把本地整体入队），当时成立是因为
 * 只有匿名身份，云端不可能有别人的数据。有了真账号之后云端**可能已经有数据**
 * （换设备登录、重装后重新绑定、或这台机器上的旧分区已经推过一轮），
 * 这时本地优先就有覆盖/污染风险，必须先让用户选：
 *
 *   - `push-local`  —— 本地整体入队推上去（与云端合并）
 *   - `keep-cloud`  —— **舍弃本地内容**，让云端成为唯一真相
 *                      （清空业务数据 + 清掉水位 → 下一轮同步全量回拉）
 *
 * 本文件是**纯逻辑 + 依赖注入**（`db` / `cloud` 传进来），因此能在 Node 里
 * 用 fake-indexeddb + 假云端测；装配层 `api/index.js` 只负责把当前分区的
 * 实例递进来。业务规则只写一次，别再在 store 或视图里重写一遍。
 *
 * `db` 的形状（都是适配器已有的能力，不新增接口）：
 *   - `db.syncStore.all(collection)` —— 读某集合全部本地文档
 *   - `db.outbox.enqueueMany(entries)` —— 批量入队
 *   - `db.kv.get/set` —— 读/写 meta 标记
 *   - `db.clearLocalData()` —— 清业务数据 + 水位（见 idbAdapter）
 * `cloud` 只需要 `pull`（用 limit=1 的探测代替新接口）。
 */
import { COLLECTIONS } from '../contract.js'

/** meta 键。与 `api/index.js`、`syncEngine` 必须一致（那边也引用这里） */
export const FIRST_BIND_DONE_KEY = 'firstBindDone'
export const SYNC_WATERMARK_KEY = 'syncWatermark'
/**
 * 「有待裁决的首绑」标记。
 *
 * 为什么光靠返回值不够：`main.js` 启动时也会跑一次判定，但那次结果没人接住，
 * 紧接着引擎的 startup 同步会把水位线写回去 —— 于是进「我的」页再问时
 * `ensureFirstBind` 已经短路成 `already-synced`，用户**永远等不到那个弹框**。
 * 所以判定出 `needs-decision` 时顺手把这个标记落到 meta 里，
 * UI 直接读标记就能把弹框拉起来（也不必重复探测云端）。
 */
export const FIRST_BIND_PENDING_KEY = 'firstBindPending'

/** 首次绑定要整体入队的三个集合 */
const SYNC_COLLECTIONS = [COLLECTIONS.LEDGER, COLLECTIONS.CATEGORY, COLLECTIONS.BILL]

/**
 * 把本地已有文档整理成 outbox 条目。
 * 全部用 `create` + 「本地优先」语义：冲突时由云端 `push` 的条件 upsert 与
 * 后续「被拒回拉」兜底（服务端更新的版本会赢回来，不会静默丢数据）。
 */
export async function collectLocalEntries(db) {
  const entries = []
  for (const collection of SYNC_COLLECTIONS) {
    const docs = await db.syncStore.all(collection)
    for (const doc of docs) {
      if (!doc || !doc.id) continue
      entries.push({ collection, op: 'create', docId: doc.id, payload: doc })
    }
  }
  return entries
}

/** 本地现有文档总数（裁决弹框里给用户看的「本地 M 条」） */
export async function countLocalDocs(db) {
  let total = 0
  for (const collection of SYNC_COLLECTIONS) {
    const docs = await db.syncStore.all(collection)
    for (const doc of docs) {
      if (doc && doc.id) total += 1
    }
  }
  return total
}

/**
 * 云端是否已有数据？
 *
 * **刻意不新增云端接口**：用 `pull(collection, { since: 0, limit: 1 })` 探一下
 * 三个集合，任意一个非空就算「已经有」。理由：
 *   - `pull` 是云端客户端的必需契约（fakeCloud 也有），不必让所有实现都补新方法；
 *   - `since: 0` 表示从最开始拉，`limit: 1` 只取一条，代价极小；
 *   - PRIVATE 权限天然把结果限制在「当前身份自己的数据」上，不需要额外过滤——
 *     「该绑定账号的数据」正是这个意思。
 *
 * ⚠️ 探测失败（没网 / 权限未生效 / 云端没配）**当作「没有」**：
 *    不能因为探测不了就卡住绑定；最坏结果只是退回 S3 的本地优先行为，
 *    而那时同步本身也多半是失败的（离线），实际不会误推。
 */
export async function cloudHasData(cloud) {
  if (!cloud || typeof cloud.pull !== 'function') return false
  // 账单最可能非空，放第一个，命中即返回
  for (const collection of [COLLECTIONS.BILL, COLLECTIONS.CATEGORY, COLLECTIONS.LEDGER]) {
    try {
      const res = await cloud.pull(collection, { since: 0, cursor: null, limit: 1 })
      if (res && Array.isArray(res.docs) && res.docs.length) return true
    } catch (e) {
      return false
    }
  }
  return false
}

/** 本地优先：整体入队 + 记「首绑已处理」标记 */
async function pushLocal(db, doneKey) {
  const entries = await collectLocalEntries(db)
  if (entries.length) await db.outbox.enqueueMany(entries)
  await db.kv.set(doneKey, Date.now())
  return { ok: true, queued: entries.length }
}

/**
 * 首次绑定判定。**只判定，不弹框**（UI 是调用方的事）。返回四种：
 *
 *   { ok: true,  queued }                              已按本地优先入队
 *   { ok: false, skipped: true, reason: 'no-kv' }      本分区没有键值仓（mock 数据源）
 *   { ok: false, skipped: true, reason: 'already-bound' | 'already-synced' }
 *                                                      已经处理过，跳过
 *   { ok: false, skipped: true, reason: 'needs-decision', localCount }
 *                                                      云端已有数据，等用户裁决
 *
 * ⚠️ `needs-decision` 时**不写标记**：用户还没选，下次启动/进「我的」页要能重新问。
 *    调用方拿到它之后应当**先别同步**（否则云端数据已经拉下来，选择就名不副实了）。
 */
export async function ensureFirstBind({
  db,
  cloud,
  doneKey = FIRST_BIND_DONE_KEY,
  watermarkKey = SYNC_WATERMARK_KEY,
  pendingKey = FIRST_BIND_PENDING_KEY
} = {}) {
  const kv = db && db.kv
  if (!kv) return { ok: false, skipped: true, reason: 'no-kv' }

  const [done, watermark] = await Promise.all([kv.get(doneKey), kv.get(watermarkKey)])
  if (done) return { ok: false, skipped: true, reason: 'already-bound' }
  // 已经有水位线 ⇒ 同步过，本地数据早就上去了，别再整体入队一遍
  if (watermark) {
    await kv.set(doneKey, Date.now())
    return { ok: false, skipped: true, reason: 'already-synced' }
  }

  const localCount = await countLocalDocs(db)
  if (await cloudHasData(cloud)) {
    const pending = { localCount, at: Date.now() }
    // 落盘成标记：启动阶段那次判定没人接住，得靠它把弹框重新拉起来
    await kv.set(pendingKey, pending)
    return { ok: false, skipped: true, reason: 'needs-decision', localCount }
  }

  const res = await pushLocal(db, doneKey)
  return { ...res, localCount }
}

/**
 * 读出「待裁决」标记；没有就返回 null。UI 用它决定要不要弹框，
 * 不必每次重新探测云端（探一次要发 1~3 个请求）。
 */
export async function readPendingFirstBind({ db, pendingKey = FIRST_BIND_PENDING_KEY } = {}) {
  const kv = db && db.kv
  if (!kv) return null
  const pending = await kv.get(pendingKey)
  if (!pending || typeof pending !== 'object') return null
  return { localCount: Number(pending.localCount) || 0 }
}

/**
 * 执行用户的裁决。
 *
 *   - `'push-local'`：本地整体入队 → 交给下一轮同步推上去。
 *   - `'keep-cloud'`：**舍弃本地** —— 清空业务数据与水位线，让云端成为唯一真相。
 *     清水位是关键：下次拉取要**从 0 全量**，否则增量拉取会因为
 *     「云端文档的时间戳早于水位」而一条都不返回，用户看到一个空账号。
 *
 * 无论选哪条，都要写 `doneKey`：这是一次性裁决，不能反复问。
 */
export async function resolveFirstBind({
  choice,
  db,
  doneKey = FIRST_BIND_DONE_KEY,
  pendingKey = FIRST_BIND_PENDING_KEY
} = {}) {
  const kv = db && db.kv
  if (!kv) throw new Error('[ledger] 本地库不可用，无法完成首次绑定')

  if (choice === 'keep-cloud') {
    if (typeof db.clearLocalData !== 'function') {
      throw new Error('[ledger] 当前数据源不支持清空本地数据')
    }
    await db.clearLocalData()
    await kv.set(doneKey, Date.now())
    if (kv.remove) await kv.remove(pendingKey)
    return { ok: true, choice, discarded: true, queued: 0 }
  }

  const res = await pushLocal(db, doneKey)
  if (kv.remove) await kv.remove(pendingKey)
  return { ...res, choice }
}
