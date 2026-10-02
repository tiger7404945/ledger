/**
 * 数据备份：导出 / 导入的**纯逻辑**（S8-1）
 * ============================================================
 * 为什么必须有这个文件（而不是「我的」页里写几十行就完事）：
 *
 *   1. **它是防厂商锁定的底线**。LeanCloud 停服那次教训写进了计划书 ——
 *      「不能把用户的数据只交给一家厂商」。导出是唯一的出口，不能是可选功能。
 *   2. **导入必须有合并规则**，而合并规则属于业务逻辑，按项目约定只能写在
 *      `core/` 一次（适配器、装配层、视图都不许各写一遍）。
 *   3. **纯函数才好测**。这里不碰 IndexedDB、不碰 DOM、不碰云端，
 *      于是「同一份文件导入两次不产生重复」这类关键性质可以在 Node 里断言。
 *
 * ## 三条设计决定
 *
 * ### ① 备份是「用户视角」的，不是「数据库视角」的
 * 导出**只含活文档**（`deleted !== 1`）—— 软删除墓碑是同步机制，不是用户的账。
 * 字段也是**白名单**（`FIELDS`），显式列举，于是：
 *   - 同步元数据（`serverUpdatedAt` 等服务端刻度）不会混进备份文件；
 *   - 将来加内部字段时，备份格式不会被动变化（格式是契约，要稳定）。
 * 代价是加业务字段要同步维护白名单 —— 由 `backup-test` 的往返断言兜底。
 *
 * ### ② 导入是**增量合并**，不是整库替换
 * 「导入备份」最像什么？最像是**换设备恢复**，其次像**把另一台设备的账并过来**。
 * 两种场景都不该删本地已有的数据。所以：
 *   - 只在**本地没有该 id** 时新增；
 *   - 本地有该 id 时比 `updatedAt`，**备份更新才覆盖**（`>` 严格大于）；
 *   - 备份里没有的本地文档，**一条都不动**。
 *
 * ### ③ 靠「原样保留 updatedAt」拿到幂等
 * 导入写库时**保留备份里的 `updatedAt` / `createdAt`**（不改成导入时刻），
 * 于是第二次导入同一份文件时「本地 updatedAt === 备份 updatedAt」，
 * 不满足严格大于 ⇒ 全部落入 skip。**导入两次 = 导入一次**，这是可断言的性质。
 *
 * ⚠️ 反过来说：如果哪天有人把导入改成「改写 updatedAt = now()」，幂等立刻破功，
 *    而且备份里的历史时间轴会被抹平 —— `backup-test` 的 7c/7d 会红。
 */

export const BACKUP_FORMAT = 'suishou-ledger-backup'

/**
 * 备份格式版本。
 *
 * 导入端只接受**小于等于**自己的版本（更新的文件说明 App 太旧，直接拒绝比
 * 猜着导入安全）。将来做不兼容变更时 +1，并在 `parseBackup` 里补迁移分支。
 */
export const BACKUP_VERSION = 1

/** 备份里的三类集合（顺序固定，导出文件的键序稳定，便于 diff） */
export const BACKUP_COLLECTIONS = ['ledgers', 'categories', 'bills']

/**
 * 字段白名单。见文件头「决定 ①」。
 *
 * `deleted` 不在名单里：导出只取活文档，导入写回时统一补 `deleted: 0`。
 */
const FIELDS = {
  ledgers: ['id', 'name', 'ownerId', 'createdAt', 'updatedAt'],
  categories: ['id', 'name', 'icon', 'parentId', 'type', 'ledgerId', 'order', 'createdAt', 'updatedAt'],
  bills: [
    'id',
    'ledgerId',
    'type',
    'amount',
    'categoryId',
    'primaryCategoryId',
    'remark',
    'date',
    'noReimburse',
    'createdAt',
    'updatedAt',
    'version'
  ]
}

/** 账单类型的历史取值（转账 / 借贷已下线，但老文档要能照常进出） */
const BILL_TYPE_VALUES = ['expense', 'income', 'transfer', 'lending']
const CATEGORY_TYPE_VALUES = ['expense', 'income']

/** 软删除标记：没有 `deleted` 字段视为活着 */
export function isAlive(doc) {
  return !doc || !doc.deleted
}

/** 只留活文档 */
export function pickAlive(docs) {
  return (docs || []).filter(isAlive)
}

/** `updatedAt` 归一化：缺失或非法一律当 0（最旧） */
function stampOf(doc) {
  const t = Number(doc?.updatedAt)
  return Number.isFinite(t) ? t : 0
}

function str(v) {
  return typeof v === 'string' ? v : ''
}

/** 按白名单抄一份**纯对象**（顺带切断 Vue Proxy 与原型链，能安全 JSON.stringify） */
function pickFields(kind, doc) {
  const out = {}
  for (const key of FIELDS[kind]) {
    const value = doc[key]
    if (value !== undefined && value !== null) out[key] = value
    else if (key === 'parentId' || key === 'categoryId' || key === 'primaryCategoryId') out[key] = null
  }
  return out
}

/**
 * 构造备份对象（**不负责序列化**，`JSON.stringify` 由调用方做）。
 *
 * @param {{data?: {ledgers?:Array, categories?:Array, bills?:Array},
 *          account?: {label?:string, signedIn?:boolean}|null,
 *          exportedAt?: number, dataSource?: string}} input
 * @returns {Object} 可直接 `JSON.stringify` 的备份对象
 */
export function buildBackup({ data = {}, account = null, exportedAt = Date.now(), dataSource = '' } = {}) {
  const out = {}
  for (const kind of BACKUP_COLLECTIONS) {
    out[kind] = pickAlive(data[kind]).map((doc) => pickFields(kind, doc))
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    app: '随手记账',
    exportedAt,
    dataSource,
    /** 只留「这是谁的备份」的最小信息：不打身份凭据，方便文件被转发后仍可辨认 */
    account: account ? { label: str(account.label), signedIn: account.signedIn === true } : null,
    counts: {
      ledgers: out.ledgers.length,
      categories: out.categories.length,
      bills: out.bills.length
    },
    data: out
  }
}

/* ---------------- 校验 ---------------- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 逐条校验 + 规范化。**坏数据不打断整份导入**（返回 null 由调用方计数跳过）。
 *
 * 尺度说明：只校验「会弄坏界面的东西」—— 缺 id / 金额非法 / 日期非法 /
 * 类型不在枚举里。名称长度之类的**业务约束不在这里卡**：那是编辑器的事，
 * 备份里的历史数据要能原样进出（比如早期版本允许的 9 字分类名）。
 */
function normalizeDoc(kind, raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = str(raw.id).trim()
  if (!id) return null

  const doc = pickFields(kind, raw)
  doc.id = id
  doc.createdAt = Number.isFinite(Number(doc.createdAt)) ? Number(doc.createdAt) : 0
  doc.updatedAt = stampOf(doc)

  if (kind === 'bills') {
    const amount = Number(doc.amount)
    if (!Number.isFinite(amount) || amount <= 0) return null
    doc.amount = amount
    if (!DATE_RE.test(str(doc.date))) return null
    doc.type = BILL_TYPE_VALUES.includes(doc.type) ? doc.type : 'expense'
    doc.ledgerId = str(doc.ledgerId)
    doc.remark = str(doc.remark)
    doc.noReimburse = doc.noReimburse === true
    doc.categoryId = doc.categoryId ? String(doc.categoryId) : null
    doc.primaryCategoryId = doc.primaryCategoryId ? String(doc.primaryCategoryId) : null
    doc.version = Number.isFinite(Number(doc.version)) ? Number(doc.version) : 1
    return doc
  }

  if (kind === 'categories') {
    const name = str(doc.name).trim()
    if (!name) return null
    doc.name = name
    if (!CATEGORY_TYPE_VALUES.includes(doc.type)) return null
    doc.parentId = doc.parentId ? String(doc.parentId) : null
    doc.ledgerId = str(doc.ledgerId)
    doc.icon = str(doc.icon) || 'more'
    doc.order = Number.isFinite(Number(doc.order)) ? Number(doc.order) : 0
    return doc
  }

  // ledgers
  const name = str(doc.name).trim()
  if (!name) return null
  doc.name = name
  doc.ownerId = str(doc.ownerId)
  return doc
}

/**
 * 解析备份文本（或已解析对象）。
 *
 * 返回值二态：
 *   - `{ ok: true, backup, invalid }` —— `invalid` 是**逐条**被跳过的坏数据计数
 *   - `{ ok: false, error }` —— 整份不可用（不是 JSON / 不是本产品的备份 / 版本过新）
 *
 * @param {string|Object} text
 */
export function parseBackup(text) {
  let raw = text
  if (typeof text === 'string') {
    try {
      raw = JSON.parse(text)
    } catch (e) {
      return { ok: false, error: '文件不是有效的 JSON' }
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '备份内容为空或格式不正确' }
  }
  if (raw.format !== BACKUP_FORMAT) {
    return { ok: false, error: '这不是「随手记账」导出的备份文件' }
  }

  const version = Number(raw.version)
  if (!Number.isFinite(version) || version <= 0) {
    return { ok: false, error: '备份文件缺少版本号' }
  }
  if (version > BACKUP_VERSION) {
    return { ok: false, error: `备份来自更新的版本（v${version}），请先升级应用再导入` }
  }

  const data = {}
  const invalid = {}
  for (const kind of BACKUP_COLLECTIONS) {
    const list = Array.isArray(raw.data?.[kind]) ? raw.data[kind] : []
    /**
     * 同 id 去重：**取 `updatedAt` 新的那条**。
     *
     * 为什么会出现同 id 两条：备份文件被人手工改过，或将来合并多个备份文件时
     * 直接拼接。与其判成坏文件，不如按「新者胜」规则收敛一次（和导入合并
     * 用的是同一条规则，行为可预期）。
     */
    const byId = new Map()
    let bad = 0
    for (const item of list) {
      const doc = normalizeDoc(kind, item)
      if (!doc) {
        bad += 1
        continue
      }
      const prev = byId.get(doc.id)
      if (!prev || stampOf(doc) > stampOf(prev)) byId.set(doc.id, doc)
    }
    data[kind] = [...byId.values()]
    invalid[kind] = bad
  }

  return {
    ok: true,
    backup: {
      format: raw.format,
      version,
      exportedAt: Number(raw.exportedAt) || 0,
      account: raw.account || null,
      /** ⚠️ 计数用**解析后**的条数，不用文件里自报的 `counts` —— 后者可能是坏的 */
      counts: {
        ledgers: data.ledgers.length,
        categories: data.categories.length,
        bills: data.bills.length
      },
      data
    },
    invalid
  }
}

/**
 * 算出「要写什么」，**不写**。调用方可以先拿它去问用户，再交给适配器落地。
 *
 * @param {{local?: Object, incoming?: Object}} input
 *   `local` / `incoming` 形状均为 `{ ledgers, categories, bills }`
 * @returns {{create: Object, update: Object, counts: {create:number, update:number, skip:number}}}
 */
export function planImport({ local = {}, incoming = {} } = {}) {
  const create = {}
  const update = {}
  const counts = { create: 0, update: 0, skip: 0 }

  for (const kind of BACKUP_COLLECTIONS) {
    const localById = new Map((local[kind] || []).map((doc) => [doc.id, doc]))
    const createList = []
    const updateList = []
    for (const doc of incoming[kind] || []) {
      const current = localById.get(doc.id)
      if (!current) {
        createList.push(doc)
        counts.create += 1
      } else if (stampOf(doc) > stampOf(current)) {
        updateList.push(doc)
        counts.update += 1
      } else {
        counts.skip += 1
      }
    }
    create[kind] = createList
    update[kind] = updateList
  }

  return { create, update, counts }
}

/** `planImport` 结果是否无事可做（用于「这份备份已经导入过」的提示） */
export function isPlanEmpty(plan) {
  return !plan || (plan.counts.create === 0 && plan.counts.update === 0)
}

/**
 * 导出文件的建议文件名：`随手记账-2026-10-02-1803.json`
 *
 * 用**本地时间**拼（用户找文件时对得上手表），而不是 UTC。
 */
export function backupFileName(at = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `随手记账-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}.json`
}
