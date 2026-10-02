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
 * ### ② 导入有两种模式：**合并**（默认）与**恢复**，由用户显式选
 *
 * 「导入备份」最像什么？两种答案都真实，而且互相冲突：
 *
 *   - **换设备恢复 / 把另一台设备的账并过来** ⇒ 不能删本地已有的数据；
 *   - **我删错了，想用备份找回来** ⇒ 必须能删掉本机多出来的、复活本机删掉的。
 *
 * 一条规则服务不了两个诉求，所以两种模式都实现：
 *
 *   - `planImport`（**合并**）—— 只在**本地没有该 id** 时新增；本地有该 id 时
 *     比 `updatedAt`，**备份更新才覆盖**（`>` 严格大于）；备份里没有的本地文档
 *     **一条都不动**。
 *   - `planRestore`（**恢复**）—— 以备份为准，把本机还原到导出那一刻：备份有
 *     本地没有的 ⇒ 新增；本机删掉的 ⇒ **复活**；两边都有但内容不同 ⇒ 覆盖；
 *     **本机有而备份里没有的 ⇒ 软删**（`remove` 桶）。不可逆，调用方**必须先
 *     取得用户确认**（见 `BackupSheet.vue` 的二次确认）。
 *
 * ⚠️ 合并模式下「本地墓碑比备份新 ⇒ 跳过」是**有意为之**，不是 bug：
 *    本项目的删除是软删（留墓碑 + `updatedAt` 抬到删除时刻），而备份里的
 *    `updatedAt` 是导出时刻，删除必然晚于导出 ⇒ 墓碑永远更新 ⇒ 整条跳过。
 *    于是「导出 → 删错 → 再导入」在合并口径下**不会**恢复 —— 这个场景由
 *    `planRestore` 承担，不是靠放宽合并规则（那会同时破坏「旧备份不覆盖新数据」）。
 *
 * ### ③ 靠「原样保留 updatedAt」拿到幂等
 * 写库时**保留备份里的 `updatedAt` / `createdAt`**（不改成导入时刻），
 * 于是第二次导入同一份文件时「本地 updatedAt === 备份 updatedAt」，
 * 合并模式不满足严格大于 ⇒ 全部落入 skip。**导入两次 = 导入一次**。
 *
 * 恢复模式的幂等靠另一条判据（它不看 `updatedAt`，以备份为准）：
 *   - 覆盖 / 复活写入的文档沿用备份的 `updatedAt` ⇒ 第二次内容比对一致 ⇒ skip；
 *   - `remove` 只挑**活**文档 ⇒ 第一次留下的墓碑第二次不会再被删。
 *
 * ⚠️ 反过来说：如果哪天有人把导入改成「改写 updatedAt = now()」，幂等立刻破功，
 *    而且备份里的历史时间轴会被抹平 —— `backup-test` 的 5f/7c 会红。
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
  ledgers: ['id', 'name', 'createdAt', 'updatedAt'],
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
    'createdAt',
    'updatedAt'
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
    doc.categoryId = doc.categoryId ? String(doc.categoryId) : null
    doc.primaryCategoryId = doc.primaryCategoryId ? String(doc.primaryCategoryId) : null
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
  return doc
}

/**
 * 两份文档在**备份语义下**是否内容一致（不看 `deleted`）。
 *
 * 为什么需要它：恢复模式以备份为准、不看 `updatedAt`，于是「本机已经就是备份
 * 那一份」的唯一判据只剩逐字段比对。少了它，同一份文件恢复两次会被判成
 * 「两边都有 ⇒ 覆盖」，数据结果虽然一样，但每次都会多出 N 条待推队列并推上云，
 * 用户看到「恢复了 187 条」而实际什么都没变 —— 幂等就只剩半个。
 *
 * 比对前两边都过一遍 `normalizeDoc`：备份里的文档已经规范化过，本地文档没有
 * （否则会出现 `version: undefined` 与 `version: 1` 这种假差异）。
 */
function sameDoc(kind, a, b) {
  const na = normalizeDoc(kind, a)
  const nb = normalizeDoc(kind, b)
  if (!na || !nb) return false
  return JSON.stringify(na) === JSON.stringify(nb)
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

/**
 * **恢复**计划：以备份为准，把本机还原到导出那一刻。
 *
 * 与 `planImport` 的三处不同（也正是「删错了想找回」这个场景缺的能力）：
 *   1. 本地是墓碑而备份里活着 ⇒ **复活**（合并模式会因「墓碑更新」而跳过）；
 *   2. 两边都有 ⇒ 只要内容不同就**覆盖**，不看 `updatedAt`（备份即真相）；
 *   3. 本机有而备份里没有的活文档 ⇒ 进 `remove` 桶，由适配器**软删**。
 *
 * 幂等仍然成立，理由见文件头「决定 ③」。
 *
 * ⚠️ 这是**唯一会主动减少本地数据**的路径，所以有两条硬约束：
 *   - `remove` **只软删**（留墓碑），否则「删」这件事传不给其他设备；
 *   - 账本单独保护：备份里**一个账本都没有**时不删本机账本 ——
 *     「没有任何账本可用」是 App 起不来的状态，宁可保留也不制造它。
 *
 * @param {{local?: Object, incoming?: Object}} input 形状同 `planImport`
 * @returns {{create: Object, update: Object, remove: Object,
 *            counts: {create:number, update:number, skip:number, remove:number, revive:number}}}
 */
export function planRestore({ local = {}, incoming = {} } = {}) {
  const create = {}
  const update = {}
  const remove = {}
  const counts = { create: 0, update: 0, skip: 0, remove: 0, revive: 0 }

  for (const kind of BACKUP_COLLECTIONS) {
    const locals = local[kind] || []
    const localById = new Map(locals.map((doc) => [doc.id, doc]))
    const incomingIds = new Set()
    const createList = []
    const updateList = []

    for (const doc of incoming[kind] || []) {
      incomingIds.add(doc.id)
      const current = localById.get(doc.id)

      if (!current) {
        createList.push(doc)
        counts.create += 1
        continue
      }
      /** 本机删过这一条、备份里还在 ⇒ 复活（「用备份找回误删」走的正是这里） */
      if (!isAlive(current)) {
        updateList.push(doc)
        counts.update += 1
        counts.revive += 1
        continue
      }
      if (sameDoc(kind, doc, current)) {
        counts.skip += 1
        continue
      }
      updateList.push(doc)
      counts.update += 1
    }

    let removeIds = locals
      .filter((doc) => !incomingIds.has(doc.id) && isAlive(doc))
      .map((doc) => doc.id)

    // 账本保护：备份里没有账本时，删空了就没账本可用
    if (kind === 'ledgers' && removeIds.length && !(incoming[kind] || []).length) {
      removeIds = []
    }

    create[kind] = createList
    update[kind] = updateList
    remove[kind] = removeIds
    counts.remove += removeIds.length
  }

  return { create, update, remove, counts }
}

/**
 * 计划是否无事可做（用于「这份备份已经导入过」的提示）。
 *
 * ⚠️ 必须一并考虑 `remove`：只清理、不新增的恢复计划同样是「有事可做」，
 *    漏掉这一项会让 UI 把「将清除 5 条」的计划当成空计划而禁用按钮。
 */
export function isPlanEmpty(plan) {
  const c = plan?.counts
  if (!c) return true
  return !c.create && !c.update && !c.remove
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
