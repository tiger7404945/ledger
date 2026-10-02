/**
 * 记账页草稿（Record Draft）
 * ------------------------------------------------------------
 * 目的：用户在记账页填了一半（选了分类、输了金额、写了备注），
 * 中途跳去「分类管理」改分类时不能丢，返回时要原样恢复。
 *
 * 为什么用 localStorage 而不是内存：
 *   内存态一旦组件卸载就没了，落 localStorage 后同一个标签页内
 *   跨路由往返都能取回。
 *
 * 生命周期（由 installRecordDraftGuard 统一裁决）：
 *   - 表单任一字段变化 → 立即写入（无需等离开页面，避免漏存）
 *   - 只在「记账页 ↔ 分类管理 / 分类编辑」这条链路内保留：
 *       · 从 /record 跳往 /category* → 保留
 *       · 从 /category* 返回 /record → 恢复
 *   - 其余任何离开方式（左上角返回、系统返回键、切 Tab、去首页/账单/统计/我的，
 *     以及直接刷新或从别处重新进入记账页）→ 立即作废草稿，
 *     避免下次进来看到上次的半成品
 *   - 保存账单成功 / 删除账单 / 重置演示数据 → clearRecordDraft()
 *
 * 注意：本模块只负责「记账页表单」这一份 UI 草稿，
 * 不属于业务数据，因此不经过 repository / outbox。
 */

export const RECORD_DRAFT_KEY = 'ledger.recordDraft.v1'
const DRAFT_VERSION = 1

/**
 * @typedef {Object} RecordDraft
 * @property {number}  v            草稿结构版本
 * @property {string}  type         expense | income
 * @property {string}  primaryId    一级分类 id
 * @property {string}  subId        二级分类 id，无则 ''
 * @property {string}  expandedId   当前展开二级面板的一级分类 id
 * @property {string}  remark       备注
 * @property {string}  dateKey      YYYY-MM-DD
 * @property {number}  acc          计算器：累加值
 * @property {string}  op           计算器：待执行运算符 '' | '+' | '-'
 * @property {string}  cur          计算器：正在输入的数字串
 * @property {string}  editingId    修改账单时的账单 id，新建时为 ''
 */

/** @returns {RecordDraft|null} */
export function readRecordDraft() {
  try {
    const raw = localStorage.getItem(RECORD_DRAFT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.v !== DRAFT_VERSION) return null
    return parsed
  } catch (e) {
    return null
  }
}

/** @param {RecordDraft} draft */
export function writeRecordDraft(draft) {
  try {
    localStorage.setItem(RECORD_DRAFT_KEY, JSON.stringify({ ...draft, v: DRAFT_VERSION }))
  } catch (e) {
    /* 忽略配额错误：草稿丢失不影响主流程 */
  }
}

export function clearRecordDraft() {
  try {
    localStorage.removeItem(RECORD_DRAFT_KEY)
  } catch (e) {
    /* 忽略 */
  }
}

/** 由表单状态组装一份草稿 */
export function buildRecordDraft(form) {
  return { v: DRAFT_VERSION, ...form }
}

/* ---------------- 生命周期策略 ---------------- */

/**
 * 草稿可以存活的页面：记账页，以及记账流程内的分类管理 / 分类编辑。
 * 只有在这两类页面之间往返时，草稿才有意义。
 * @param {string} path
 */
export function isDraftScopedPath(path) {
  const p = String(path || '')
  return p === '/record' || p.startsWith('/category')
}

/**
 * 把草稿生命周期接到路由上（创建 router 后调用一次）。
 *
 * 策略：草稿是「一次编辑会话」的临时状态，只有为了改分类而短暂离开
 * 记账页时才值得保留；用户真正退出记账页后就不该再留下痕迹。
 *
 * @param {import('vue-router').Router} router
 */
export function installRecordDraftGuard(router) {
  router.beforeEach((to, from) => {
    // 1) 离开记账链路（回首页、切 Tab、看账单…）：草稿立即作废
    if (!isDraftScopedPath(to.path)) {
      clearRecordDraft()
      return
    }
    // 2) 进入记账页：只有从分类管理 / 分类编辑返回才允许恢复，
    //    从首页、账单页等入口进来（含首次打开、刷新）一律从干净状态开始
    if (to.path === '/record' && !String(from.path || '').startsWith('/category')) {
      clearRecordDraft()
    }
  })
}
