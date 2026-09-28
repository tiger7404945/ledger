import { addDays, toDateKey, currentMonthKey, monthKeyOf } from '../../utils/date.js'
import { round2 } from '../../utils/money.js'

/**
 * Mock 种子数据
 * 参考截图还原：支出 17 个一级分类（含 4 个带二级分类）、收入 7 个一级分类，
 * 以及 2026 年 9 月的账单流水（本月支出精确为 ¥8720.72）。
 */

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
  { key: 'insurance', name: '保险', icon: 'membership' },
  { key: 'goose', name: '卤鹅', icon: 'duck' }
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
 * 账单模板：offset = 距今天数（0 = 今天）
 * cat 为一级分类 key，sub 为二级分类 key
 */
const BILL_TEMPLATES = [
  { offset: 0, cat: 'traffic', sub: 'traffic-bus', amount: 40.0 },
  { offset: 1, cat: 'traffic', amount: 25.25, remark: 'ETC' },
  { offset: 2, cat: 'snack', sub: 'snack-fruit', amount: 18.0 },
  { offset: 2, cat: 'clothes', amount: 57.0 },
  { offset: 2, cat: 'food', amount: 22.7 },
  { offset: 3, cat: 'traffic', sub: 'traffic-parking', amount: 15.0 },
  { offset: 4, cat: 'daily', amount: 45.6 },
  { offset: 5, cat: 'food', amount: 88.0, remark: '同事聚餐' },
  { offset: 6, cat: 'snack', amount: 12.0 },
  { offset: 7, cat: 'other', amount: 39.9 },
  { offset: 8, cat: 'traffic', sub: 'traffic-fuel', amount: 300.0 },
  { offset: 9, cat: 'insurance', amount: 168.0 },
  { offset: 10, cat: 'snack', sub: 'snack-milktea', amount: 26.0 },
  { offset: 11, cat: 'repair', amount: 320.0, remark: '汽车保养' },
  { offset: 12, cat: 'shopping', amount: 168.8 },
  { offset: 13, cat: 'food', amount: 210.0 },
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
  { offset: 24, cat: 'food', amount: 168.0 },
  { offset: 25, cat: 'house', sub: 'house-utility', amount: 268.0 },
  { offset: 26, cat: 'house', sub: 'house-rent', amount: 4500.0, remark: '9月房租' }
]

/** 本月支出目标值（与参考截图一致） */
const MONTH_EXPENSE_TARGET = 8720.72

export function buildSeed() {
  const ts = Date.now()
  const ledger = {
    id: LEDGER_ID,
    name: '默认账本',
    ownerId: 'user_local',
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
        updatedAt: ts,
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
          updatedAt: ts,
          deleted: 0
        })
      })
    })
  }
  pushTree(CATEGORY_TREE, 'expense')
  pushTree(INCOME_TREE, 'income')

  const mainOf = (subKey) => SUB_ID(subKey).replace('sub_', 'cat_').split('-')[0]

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
      noReimburse: false,
      createdAt: ts - index * 1000,
      updatedAt: ts - index * 1000,
      deleted: 0,
      version: 1
    }
  })

  // 让「本月支出」精确等于目标值：补一笔本月的购物支出
  const month = currentMonthKey()
  const monthSum = bills
    .filter((b) => monthKeyOf(b.date) === month)
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
      remark: '数码配件',
      date: `${month}-01`,
      noReimburse: false,
      createdAt: ts + 1,
      updatedAt: ts + 1,
      deleted: 0,
      version: 1
    })
  }

  return { ledgers: [ledger], categories, bills }
}
