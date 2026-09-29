/**
 * 数据层装配入口
 * ------------------------------------------------------------
 * 视图与 store 只依赖这里导出的 repository，不关心底层实现。
 * 第二阶段切换本地缓存 / 云端同步时，只需改动 DATA_SOURCE 与 cloud。
 */
import { createMockAdapter } from './adapters/mockAdapter.js'
import { createIdbAdapter } from './adapters/idbAdapter.js'
import { createCloudBaseAdapter } from './adapters/cloudbaseAdapter.js'
import { createSyncEngine } from './sync/syncEngine.js'
import { cloudEnvId, isCloudConfigured } from '../config/env.js'
import { COLLECTIONS } from './contract.js'

const ADAPTERS = {
  mock: createMockAdapter,
  idb: createIdbAdapter
}

/** 各数据源的构造参数 */
const ADAPTER_OPTIONS = {
  mock: { latency: 24 },
  idb: { dbName: 'ledger' }
}

/**
 * 当前数据源：mock | idb
 * 第二阶段已切到 idb（IndexedDB）：数据真正落在本机数据库里，刷新/重启不丢，
 * 同步队列（outbox）也搬进了同一个库。切回 mock 只需改这一行。
 */
export const DATA_SOURCE = 'idb'

export const db = ADAPTERS[DATA_SOURCE](ADAPTER_OPTIONS[DATA_SOURCE])

export const ledgerRepo = db.ledger
export const categoryRepo = db.category
export const billRepo = db.bill

/**
 * 云端客户端（第二阶段 S3）
 *
 * 没配 `.env.local` 里的 `VITE_CLOUDBASE_ENV` 时是 `null` —— 同步引擎会直接跳过
 * （返回 `{ ok: false, skipped: true, reason: 'no-cloud' }`），应用照常本地记账，
 * 不白屏、不报错。配了就换成真实的 CloudBase 适配器。
 *
 * 它只实现了 `sync/cloudClient.js` 的三个方法（pull / push / serverTime），
 * 所以 **syncEngine 一行都没改** —— S2 把接口单独抽出来的意义就在这里。
 *
 * 接入的过程、SDK 选型的三轮实测结论、以及云端资源清单，
 * 见 phase2-backend-plan.md 的 S3 小节与 .workbuddy/memory/2026-09-29.md。
 */
export const cloud = isCloudConfigured ? createCloudBaseAdapter({ env: cloudEnvId }) : null

/**
 * 同步引擎（第二阶段 S2）
 *
 * 它自己不做网络，只做调度：什么时候同步、失败了怎么退避、被云端拒绝怎么办。
 * 启动入口在 `main.js`（`ensureCloudFirstBind()` 之后调 `syncEngine.start()`）。
 */
export const syncEngine = createSyncEngine({
  /** 待推队列 —— 适配器写操作时往里投递 */
  outbox: db.outbox,
  /** 本地读写口 —— 引擎只认「读一条 / 写一批 / 读全量」，不碰 IndexedDB 细节 */
  store: db.syncStore,
  /** 键值仓（存水位线）。mock 数据源没有持久化，传 null 即可 */
  meta: db.kv || null,
  cloud
})

/* ---------------- 首次绑定 ---------------- */

/** 「已经做过首次绑定」的标记（meta 表） */
const FIRST_BIND_KEY = 'firstBindDone'
/** 与 syncEngine 的 watermarkKey 保持一致 */
const WATERMARK_KEY = 'syncWatermark'

/**
 * 首次绑定：把本地已有数据**整体入队**，交给第一次同步推上云。
 *
 * 为什么需要它：种子数据是直接写进本地库的，**没有经过 outbox**，
 * 所以不做这一步的话，用户一开始看到的那些账目永远不会上云 ——
 * 于是「清空本地再从云端恢复」这条路根本无从谈起。
 *
 * 策略选的是「本地优先」。另一半（先问用户要本地还是要云端）留到 S5：
 * 现在匿名账号就是设备身份、换不了设备，云端不可能有别人写的旧数据，
 * 因此本地优先没有覆盖风险；等真账号能跨设备登录了，就必须改成先问用户。
 *
 * 幂等：标记写在 meta 表，只做一次。重置演示数据会清掉这个标记，
 * 于是重置后会重新绑定（配合「重置时一并清掉云端」，语义才是对的）。
 */
export async function ensureCloudFirstBind() {
  if (!cloud) return { ok: false, skipped: true, reason: 'no-cloud' }
  if (!db.kv) return { ok: false, skipped: true, reason: 'no-kv' }

  const [done, watermark] = await Promise.all([
    db.kv.get(FIRST_BIND_KEY),
    db.kv.get(WATERMARK_KEY)
  ])
  if (done) return { ok: false, skipped: true, reason: 'already-bound' }
  // 已经有水位线 ⇒ 同步过，本地数据早就上去了，别再整体入队一遍
  if (watermark) {
    await db.kv.set(FIRST_BIND_KEY, Date.now())
    return { ok: false, skipped: true, reason: 'already-synced' }
  }

  const entries = []
  for (const collection of [COLLECTIONS.LEDGER, COLLECTIONS.CATEGORY, COLLECTIONS.BILL]) {
    const docs = await db.syncStore.all(collection)
    for (const doc of docs) {
      if (!doc || !doc.id) continue
      entries.push({ collection, op: 'create', docId: doc.id, payload: doc })
    }
  }

  if (entries.length) await db.outbox.enqueueMany(entries)
  await db.kv.set(FIRST_BIND_KEY, Date.now())
  return { ok: true, queued: entries.length }
}

export { COLLECTIONS, BILL_TYPES, CATEGORY_TYPES, NAME_MAX_LENGTH } from './contract.js'
export { NotImplementedError, RepositoryError, SCHEMA_VERSION } from './contract.js'
