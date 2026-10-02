import {
  addDays,
  toDateKey,
  todayKey,
  currentMonthKey,
  monthKeyOf,
  shiftMonth,
  pad2
} from '../../utils/date.js'
import { round2 } from '../../utils/money.js'

/**
 * Mock 种子数据
 * 参考截图还原：支出 16 个一级分类（含 5 个带二级分类）、收入 7 个一级分类，
 * 以及 2026 年 9 月的账单流水（本月支出精确为 ¥8720.72）。
 * 合计 41 条分类（34 支出 + 7 收入）。
 *
 * ## 种子分两层（S7-9）
 *
 * 这里的「种子」原本捆着三样性质完全不同的东西，接云端之后成了一条**静默的
 * 数据污染链**（新账号首次登录 → 空分区 ⇒ 播种整套 → 整批推上云 → 账号里
 * 凭空多出 ¥8720.72 演示账）。所以按性质拆开：
 *
 *   | 内容 | 性质 | 谁需要 | 播不播 |
 *   | --- | --- | --- | --- |
 *   | 账本 + 分类（{@link buildBase}） | **基础设施** —— 没有它记不了账、宫格是空的 | 全部场景 | **始终播** |
 *   | 演示账单（{@link buildDemoBills}） | **演示数据** —— 某个人编出来的账 | 开发 / 设计稿对照 | 仅开发构建 |
 *
 * `buildSeed()` 是组合入口，`mode` 决定要不要带上演示账单：
 *   - `'full'` —— 基础设施 + 演示账单（开发构建下的未登录分区）；
 *   - `'base'` —— 只有基础设施（登录后的账号分区、生产构建）。
 *
 * ⚠️ **不要为了少播演示数据去 bump `SCHEMA_VERSION`**：那会让适配器认定数据结构
 *    不兼容而重新播种，把用户自己记的账清空。补数据走 `SEED_EXTRA_VERSION`。
 */

/**
 * 是否「开发构建」。
 *
 * ⚠️ 写成 `import.meta.env.DEV`（而不是从 `config/env.js` 取 `IS_DEV`）是有意的：
 *    Vite 在**生产构建时会把这一处整段替换成 `false`**，于是下面 `buildDemoBills`
 *    里那段账单数据成为死代码，打包器可以把它摇掉 —— 我们要的是「生产包里根本
 *    没有演示数据」，而不是「有数据但运行时不读」。
 *
 * ⚠️ `try/catch` 是给 Node 用的：`scripts/*.mjs` 里 `import.meta.env` 不存在，
 *    访问 `.DEV` 会抛 TypeError。测试脚本按「开发构建」处理（除非显式设了
 *    `NODE_ENV=production`），否则演示数据相关断言没有数据可测。
 */
const DEMO_ENABLED = (() => {
  try {
    return Boolean(import.meta.env.DEV)
  } catch (e) {
    return typeof process === 'undefined' || process.env?.NODE_ENV !== 'production'
  }
})()

/** 播种档位。`base` = 只播基础设施，`full` = 基础设施 + 演示账单 */
export const SEED_MODE = {
  BASE: 'base',
  FULL: 'full'
}

export const LEDGER_ID = 'ledger_default'

/** 一级分类 + 二级分类定义 */
const CATEGORY_TREE = [
  { key: 'food', name: '餐饮', icon: 'cutlery' },
  {
    key: 'snack',
    name: '零食',
    icon: 'can',
    subs: [
      { key: 'snack-fruit', name: '水果', icon: 'apple' },
      { key: 'snack-milktea', name: '奶茶', icon: 'lollipop' },
      { key: 'snack-dessert', name: '甜品', icon: 'cake' }
    ]
  },
  { key: 'daily', name: '日用', icon: 'box' },
  {
    key: 'house',
    name: '住房',
    icon: 'house',
    subs: [
      { key: 'house-rent', name: '房租', icon: 'bed' },
      { key: 'house-utility', name: '水电燃气', icon: 'drop' },
      { key: 'house-property', name: '物业费', icon: 'houseLoan' },
      { key: 'house-furniture', name: '家居', icon: 'bolt' }
    ]
  },
  {
    key: 'traffic',
    name: '交通',
    icon: 'bus',
    subs: [
      { key: 'traffic-bus', name: '公交地铁', icon: 'bus' },
      { key: 'traffic-taxi', name: '打车租车', icon: 'taxi' },
      { key: 'traffic-parking', name: '停车费', icon: 'parking' },
      { key: 'traffic-train', name: '火车高铁', icon: 'train' },
      { key: 'traffic-fuel', name: '加油', icon: 'fuel' }
    ]
  },
  { key: 'clothes', name: '服饰', icon: 'tshirt' },
  {
    key: 'fun',
    name: '娱乐',
    icon: 'laugh',
    subs: [
      { key: 'fun-movie', name: '电影', icon: 'film' },
      { key: 'fun-game', name: '游戏', icon: 'gamepad' },
      { key: 'fun-show', name: '演出', icon: 'ticket' }
    ]
  },
  { key: 'broadband', name: '宽带', icon: 'wifi' },
  { key: 'phone', name: '手机通讯', icon: 'call' },
  {
    key: 'gift',
    name: '人情',
    icon: 'gift',
    subs: [
      { key: 'gift-redpacket', name: '红包', icon: 'redpacket' },
      { key: 'gift-treat', name: '请客', icon: 'wineglass' },
      { key: 'gift-present', name: '送礼', icon: 'flower' }
    ]
  },
  { key: 'shopping', name: '购物', icon: 'cart' },
  { key: 'other', name: '其它', icon: 'more' },
  { key: 'repair', name: '维修保养', icon: 'car' },
  { key: 'medical', name: '医疗', icon: 'medkit' },
  { key: 'edu', name: '教育', icon: 'cap' },
  { key: 'insurance', name: '保险', icon: 'membership' }
]

const INCOME_TREE = [
  { key: 'salary', name: '工资', icon: 'wallet' },
  { key: 'bonus', name: '奖金', icon: 'star' },
  { key: 'parttime', name: '兼职', icon: 'clock' },
  { key: 'invest', name: '投资', icon: 'stats' },
  { key: 'iredpacket', name: '红包', icon: 'redpacket' },
  { key: 'reimburse', name: '报销', icon: 'bill' },
  { key: 'iother', name: '其它', icon: 'more' }
]

export const CAT_ID = (key) => `cat_${key}`
export const SUB_ID = (key) => `sub_${key}`

/**
 * 种子**历史上播过、现已废弃**的分类 id 名单（S8-7）。
 *
 * 背景：`卤鹅`（`cat_goose`）是早期为了让宫格多一格而加进来的玩笑分类，
 * 与设计稿还原的其余分类不是一回事，用户要求去掉。从 {@link CATEGORY_TREE}
 * 删掉只能让**新库**不再有它 —— 已经播种过的库（本地 IndexedDB + 云端集合）
 * 里那份还在，得由适配器按这份名单清掉。
 *
 * ⚠️ 名单只放**固定 id 的种子分类**。用户自己建的分类 id 是 `uid('cat')`
 *    随机串，绝不会撞上 `cat_goose`，所以这个清理不会误伤用户自建的分类。
 *    反过来说：**别把这个名单扩大成「按名字匹配」** —— 用户完全可以自己
 *    建一个叫「卤鹅」的分类，那是他的自由，不该被系统悄悄删掉。
 */
export const REMOVED_SEED_CATEGORY_IDS = [CAT_ID('goose')]

/**
 * 账单模板：offset = 距今天数（0 = 今天）
 * cat 为一级分类 key，sub 为二级分类 key
 */
const BILL_TEMPLATES = [
  { offset: 0, cat: 'traffic', sub: 'traffic-bus', amount: 40.0, remark: '地铁通勤' },
  { offset: 1, cat: 'traffic', amount: 25.25, remark: 'ETC' },
  { offset: 2, cat: 'snack', sub: 'snack-fruit', amount: 18.0 },
  { offset: 2, cat: 'clothes', amount: 57.0 },
  { offset: 2, cat: 'food', amount: 22.7, remark: '公司食堂' },
  { offset: 3, cat: 'traffic', sub: 'traffic-parking', amount: 15.0, remark: '停车场' },
  { offset: 4, cat: 'daily', amount: 45.6 },
  { offset: 5, cat: 'food', amount: 88.0, remark: '同事聚餐' },
  { offset: 6, cat: 'snack', amount: 12.0 },
  { offset: 7, cat: 'other', amount: 39.9 },
  { offset: 8, cat: 'traffic', sub: 'traffic-fuel', amount: 300.0 },
  { offset: 9, cat: 'insurance', amount: 168.0 },
  { offset: 10, cat: 'snack', sub: 'snack-milktea', amount: 26.0 },
  { offset: 11, cat: 'repair', amount: 320.0, remark: '汽车保养' },
  { offset: 12, cat: 'shopping', amount: 168.8 },
  { offset: 13, cat: 'food', amount: 210.0, remark: '星巴克' },
  { offset: 14, cat: 'daily', amount: 96.3 },
  { offset: 15, cat: 'phone', amount: 129.0 },
  { offset: 16, cat: 'broadband', amount: 78.0 },
  { offset: 17, cat: 'snack', sub: 'snack-fruit', amount: 42.5 },
  { offset: 18, cat: 'gift', sub: 'gift-redpacket', amount: 600.0, remark: '朋友结婚' },
  { offset: 19, cat: 'fun', sub: 'fun-movie', amount: 76.0 },
  { offset: 20, cat: 'medical', amount: 156.0 },
  { offset: 21, cat: 'traffic', sub: 'traffic-taxi', amount: 88.0 },
  { offset: 22, cat: 'clothes', amount: 320.0 },
  { offset: 23, cat: 'edu', amount: 480.0, remark: '线上课程' },
  { offset: 24, cat: 'food', amount: 168.0, remark: '外卖' },
  { offset: 25, cat: 'house', sub: 'house-utility', amount: 268.0 },
  { offset: 26, cat: 'house', sub: 'house-rent', amount: 4500.0, remark: '9月房租' }
]

/** 本月支出目标值（与参考截图一致） */
const MONTH_EXPENSE_TARGET = 8720.72

/**
 * 补充账单模板（收入 + 往月流水）
 *
 * 原始种子只有「本月支出」，统计页的收入视图、按天/按月趋势都没有数据可看。
 * 这里补两层：
 * - `monthOffset: 0` 的收入 —— 本月用 `offset`（距今天数）表达并夹在本月月内，
 *   保证月初运行时也不会落到上月；本月支出目标 8720.72 不受影响。
 * - `monthOffset: -1 / -2` 的收支 —— 让「按年」趋势有多个点，而不是一个月独苗。
 */
const EXTRA_BILL_TEMPLATES = [
  { monthOffset: 0, offset: 2, type: 'income', cat: 'salary', amount: 12000, remark: '月薪' },
  { monthOffset: 0, offset: 7, type: 'income', cat: 'parttime', amount: 1200, remark: '周末兼职' },
  { monthOffset: 0, offset: 12, type: 'income', cat: 'reimburse', amount: 368.5, remark: '差旅报销' },
  { monthOffset: 0, offset: 19, type: 'income', cat: 'iredpacket', amount: 200, remark: '朋友红包' },
  { monthOffset: -1, day: 10, type: 'income', cat: 'salary', amount: 12000, remark: '月薪' },
  { monthOffset: -1, day: 15, type: 'income', cat: 'bonus', amount: 3000, remark: '季度奖金' },
  { monthOffset: -1, day: 1, type: 'expense', cat: 'house', sub: 'house-rent', amount: 4500, remark: '房租' },
  { monthOffset: -1, day: 8, type: 'expense', cat: 'food', amount: 326.5, remark: '朋友聚餐' },
  { monthOffset: -1, day: 20, type: 'expense', cat: 'shopping', amount: 899, remark: '蓝牙耳机' },
  { monthOffset: -2, day: 10, type: 'income', cat: 'salary', amount: 12000, remark: '月薪' },
  { monthOffset: -2, day: 18, type: 'income', cat: 'parttime', amount: 2600, remark: '外包项目' },
  { monthOffset: -2, day: 1, type: 'expense', cat: 'house', sub: 'house-rent', amount: 4500, remark: '房租' },
  { monthOffset: -2, day: 6, type: 'expense', cat: 'traffic', sub: 'traffic-fuel', amount: 300, remark: '加油' },
  { monthOffset: -2, day: 24, type: 'expense', cat: 'medical', amount: 420, remark: '体检' }
]

/** 补充账单的播种版本：适配器据此给早期本地库补数据（幂等，只补缺的 id） */
export const SEED_EXTRA_VERSION = 1

/**
 * 生成补充账单。id 固定，便于按 id 幂等回填到已有本地库。
 * @param {number} ts 时间戳，用于 createdAt / updatedAt
 */
export function buildExtraBills(ts = Date.now()) {
  const month = currentMonthKey()
  const todayDay = Number(todayKey().slice(8, 10))
  return EXTRA_BILL_TEMPLATES.map((tpl, index) => {
    const targetMonth = shiftMonth(month, tpl.monthOffset || 0)
    const day = tpl.offset != null ? Math.max(1, todayDay - tpl.offset) : tpl.day
    const primaryId = CAT_ID(tpl.cat)
    return {
      id: `bill_seed_extra_${pad2(index + 1)}`,
      ledgerId: LEDGER_ID,
      type: tpl.type,
      amount: round2(tpl.amount),
      categoryId: tpl.sub ? SUB_ID(tpl.sub) : primaryId,
      primaryCategoryId: primaryId,
      remark: tpl.remark || '',
      date: `${targetMonth}-${pad2(day)}`,
      createdAt: ts - 5000 - index * 1000,
      updatedAt: ts - 5000 - index * 1000,
      deleted: 0
    }
  })
}

/** 补齐差额那笔「购物」账单的备注 */
const GAP_BILL_REMARK = '数码配件'

/**
 * 种子账单 id → 备注
 * 用途：早期版本播种的本地库里这些演示账单没有备注（备注字段是后加的），
 * 适配器加载时按 id 一次性回填，让「填写备注」的历史候选立刻有数据可展示，
 * 又不必清空用户自己记的账。
 */
export const SEED_NOTES_VERSION = 1

export const SEED_BILL_NOTES = (() => {
  const map = {}
  BILL_TEMPLATES.forEach((tpl, index) => {
    if (!tpl.remark) return
    map[`bill_seed_${String(index + 1).padStart(3, '0')}`] = tpl.remark
  })
  map.bill_seed_gap = GAP_BILL_REMARK
  return map
})()

/**
 * 基础设施种子：账本 + 分类。
 *
 * **每一个分区都要播它**，否则新用户打开 App 看到的是「没有账本 + 空宫格」，
 * 连一笔账都记不了（`ledgerStore.currentId` 也依赖 `ledger_default` 存在）。
 *
 * @param {number} [ts] 时间戳（createdAt / updatedAt 用）
 * @param {{ categoryUpdatedAt?: number|null }} [options]
 *   `categoryUpdatedAt` —— 分类专用时间戳，不传则用 `ts`。
 *   ⚠️ **登录后的账号分区必须传 `0`**：登录时本地会先播一份默认分类，随后
 *   全量回拉云端。若这份默认分类带着「刚刚生成」的新时间戳，合并裁决
 *   （新者胜）会让它**盖掉用户在云端改过的分类名/图标**。
 *   置 0 的语义是「这是默认值，优先级最低」：云端有同名 id 的，云端赢；
 *   云端没有（全新账号），这份默认分类被推上去，换设备登录也带得走。
 * @returns {{ ledgers: Array, categories: Array }}
 */
export function buildBase(ts = Date.now(), { categoryUpdatedAt = null } = {}) {
  // ⚠️ 不能用 `Number(categoryUpdatedAt)` 直接判：`Number(null)` 是 0，
  //    会把「没传」误判成「显式传了 0」。null/undefined 都表示「用 ts」。
  const catTs =
    categoryUpdatedAt === null || categoryUpdatedAt === undefined
      ? ts
      : Number(categoryUpdatedAt) || 0

  const ledger = {
    id: LEDGER_ID,
    name: '默认账本',
    createdAt: ts,
    updatedAt: ts
  }

  const categories = []
  const pushTree = (tree, type) => {
    tree.forEach((node, index) => {
      categories.push({
        id: CAT_ID(node.key),
        name: node.name,
        icon: node.icon,
        parentId: null,
        type,
        ledgerId: LEDGER_ID,
        order: index,
        createdAt: ts,
        updatedAt: catTs,
        deleted: 0
      })
      ;(node.subs || []).forEach((sub, subIndex) => {
        categories.push({
          id: SUB_ID(sub.key),
          name: sub.name,
          icon: sub.icon,
          parentId: CAT_ID(node.key),
          type,
          ledgerId: LEDGER_ID,
          order: subIndex,
          createdAt: ts,
          updatedAt: catTs,
          deleted: 0
        })
      })
    })
  }
  pushTree(CATEGORY_TREE, 'expense')
  pushTree(INCOME_TREE, 'income')

  return { ledgers: [ledger], categories }
}

/**
 * 演示账单种子：本月支出（精确到 ¥8720.72）+ 补充收入与往月流水。
 *
 * ⚠️ **只在开发构建下返回数据，生产构建返回 `[]`** —— 见 `DEMO_ENABLED`。
 *    它是「某个人编出来的账」，不该出现在真账号里。
 *
 * @param {number} [ts] 时间戳
 * @returns {Array} 账单数组（含差额补齐那笔与补充账单）
 */
export function buildDemoBills(ts = Date.now()) {
  if (!DEMO_ENABLED) return []

  const bills = BILL_TEMPLATES.map((tpl, index) => {
    const date = toDateKey(addDays(new Date(), -tpl.offset))
    const primaryId = CAT_ID(tpl.cat)
    const categoryId = tpl.sub ? SUB_ID(tpl.sub) : primaryId
    return {
      id: `bill_seed_${String(index + 1).padStart(3, '0')}`,
      ledgerId: LEDGER_ID,
      type: 'expense',
      amount: round2(tpl.amount),
      categoryId,
      primaryCategoryId: primaryId,
      remark: tpl.remark || '',
      date,
      createdAt: ts - index * 1000,
      updatedAt: ts - index * 1000,
      deleted: 0
    }
  })

  // 让「本月支出」精确等于目标值：补一笔本月的购物支出
  const month = currentMonthKey()
  const monthSum = bills
    .filter((b) => b.type === 'expense' && monthKeyOf(b.date) === month)
    .reduce((sum, b) => sum + b.amount, 0)
  const gap = round2(MONTH_EXPENSE_TARGET - monthSum)
  if (gap > 0) {
    bills.push({
      id: 'bill_seed_gap',
      ledgerId: LEDGER_ID,
      type: 'expense',
      amount: gap,
      categoryId: CAT_ID('shopping'),
      primaryCategoryId: CAT_ID('shopping'),
      remark: GAP_BILL_REMARK,
      date: `${month}-01`,
      createdAt: ts + 1,
      updatedAt: ts + 1,
      deleted: 0
    })
  }

  // 补充账单放在差额补齐之后，保证「本月支出 = 8720.72」的等式不受收入影响
  bills.push(...buildExtraBills(ts))

  return bills
}

/**
 * 组合入口：按 `mode` 播种。
 *
 * @param {number} [ts]
 * @param {{ mode?: 'base'|'full', categoryUpdatedAt?: number|null }} [options]
 * @returns {{ ledgers: Array, categories: Array, bills: Array, meta: object }}
 *   `meta` 的演示数据迁移标记**只在真播了账单时**才带上 —— 没播就没得迁移，
 *   带上会让 `migrateSeedData` 误以为「已经补过了」。
 */
export function buildSeed(ts = Date.now(), { mode = SEED_MODE.FULL, categoryUpdatedAt = null } = {}) {
  const { ledgers, categories } = buildBase(ts, { categoryUpdatedAt })
  const bills = mode === SEED_MODE.FULL ? buildDemoBills(ts) : []

  return {
    ledgers,
    categories,
    bills,
    // 迁移标记：本次播种已带备注、已带补充账单，适配器无需再回填
    meta: bills.length
      ? { seedNotes: SEED_NOTES_VERSION, seedExtra: SEED_EXTRA_VERSION }
      : {}
  }
}
