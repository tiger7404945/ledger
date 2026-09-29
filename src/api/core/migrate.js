/**
 * ============================================================
 *  演示数据的增量迁移（纯逻辑，无 IO）
 * ============================================================
 *  给「已经存在于用户本地」的数据补演示内容时使用。两条硬规则：
 *
 *    1) 只补不覆盖 —— 按 id 回填，绝不改动用户自己记的账；
 *    2) 幂等 —— 靠 meta 里的版本标记判断是否需要跑，重复执行结果不变。
 *
 *  ⚠️ 不要为了补演示数据去 bump SCHEMA_VERSION：那会让适配器认定数据结构
 *     不兼容而重新播种，把用户自己记的账清空。
 *
 *  mockAdapter 与 idbAdapter 共用这一份实现，避免两边规则漂移。
 */
import {
  buildExtraBills,
  SEED_BILL_NOTES,
  SEED_NOTES_VERSION,
  SEED_EXTRA_VERSION
} from '../mock/seed.js'

/**
 * @param {Array} bills 账单数组，会被原地修改（新增的补充账单直接 push 进来）
 * @param {Object} meta 迁移标记对象，会被原地修改
 * @returns {{changed:boolean, added:Array, updated:Array}}
 *   added / updated 是「需要写回存储」的账单，供适配器做增量落盘；
 *   内存型适配器（mockAdapter）可以直接忽略它们、整体重写。
 */
export function migrateSeedData(bills, meta = {}) {
  const added = []
  const updated = []
  let changed = false

  // 1) 早期播种的演示账单没有备注字段，按 id 回填，让记账页的备注候选有历史
  if (meta.seedNotes !== SEED_NOTES_VERSION) {
    bills.forEach((b) => {
      const note = SEED_BILL_NOTES[b.id]
      if (note && !b.remark) {
        b.remark = note
        updated.push(b)
      }
    })
    meta.seedNotes = SEED_NOTES_VERSION
    changed = true
  }

  // 2) 后加的演示账单（本月收入 + 往月收支）按 id 补齐，让统计页有数据可看
  if (meta.seedExtra !== SEED_EXTRA_VERSION) {
    const have = new Set(bills.map((b) => b.id))
    buildExtraBills().forEach((b) => {
      if (have.has(b.id)) return
      bills.push(b)
      added.push(b)
    })
    meta.seedExtra = SEED_EXTRA_VERSION
    changed = true
  }

  return { changed, added, updated }
}
