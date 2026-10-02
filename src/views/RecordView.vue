<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useCategoryStore } from '@/stores/category.js'
import { useBillStore } from '@/stores/bill.js'
import { useLedgerStore } from '@/stores/ledger.js'
import { useToast } from '@/composables/useToast.js'
import {
  clearRecordDraft,
  readRecordDraft,
  writeRecordDraft
} from '@/composables/useRecordDraft.js'
import AppHeader from '@/components/AppHeader.vue'
import IconBase from '@/components/icons/IconBase.vue'
import CategoryGrid from '@/components/CategoryGrid.vue'
import SubCategoryPanel from '@/components/SubCategoryPanel.vue'
import RecordPanel from '@/components/RecordPanel.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { formatTyping, round2, toAmount } from '@/utils/money.js'
import { todayKey } from '@/utils/date.js'

const route = useRoute()
const router = useRouter()
const categoryStore = useCategoryStore()
const billStore = useBillStore()
const ledgerStore = useLedgerStore()
const toast = useToast()

/**
 * 记账类型只留**支出 / 收入**。
 *
 * 「转账」「借贷」已在第二阶段按产品决定砍掉：它们从未真正建模
 * （提交时被折叠成 `expense`，见下面的 payload），也没有独立的分类体系，
 * 留着就是两个「点了会记成支出的」假入口。
 */
const TYPES = [
  { key: 'expense', label: '支出' },
  { key: 'income', label: '收入' }
]

const MANAGE_ENTRY = { id: '__manage__', name: '分类管理', icon: 'settings' }

/* ---------------- 表单状态 ---------------- */
const type = ref('expense')
const primaryId = ref('')
const subId = ref('')
const expandedId = ref('')
const remark = ref('')
const dateKey = ref(todayKey())
const editingId = ref('')
const confirmOpen = ref(false)
const loading = ref(false)

/* 金额：acc + op + cur 组成一个极简计算器 */
const acc = ref(0)
const op = ref(null)
const cur = ref('')

const amountText = computed(() => {
  if (cur.value !== '') return formatTyping(cur.value)
  if (op.value) return formatTyping(String(acc.value))
  return acc.value === 0 ? '0.00' : formatTyping(String(acc.value))
})

/* ---------------- 分类数据 ---------------- */
const primaries = computed(() => categoryStore.primaries(type.value))

const badges = computed(() =>
  primaries.value.filter((c) => categoryStore.hasChildren(c.id)).map((c) => c.id)
)

const items = computed(() => {
  const list = primaries.value.map((c) => ({ id: c.id, name: c.name, icon: c.icon }))
  if (type.value === 'expense') list.push(MANAGE_ENTRY)
  return list
})

const expandedChildren = computed(() =>
  expandedId.value ? categoryStore.children(expandedId.value) : []
)

const selectedTitle = computed(() => {
  const id = subId.value || primaryId.value
  return id ? categoryStore.label(id) : '未选择分类'
})

const isExpense = computed(() => type.value === 'expense')

/** 当前生效的分类（二级优先），决定「填写备注」的历史候选来自哪个分类 */
const currentCategoryId = computed(() => subId.value || primaryId.value)

/** 当前分类下的历史备注，从新到旧 */
const remarkSuggestions = ref([])

/* ---------------- 交互 ---------------- */
/** 数据源就绪后，默认选中当前类型的第一个一级分类 */
function selectFirstPrimary() {
  const first = primaries.value[0]
  if (first) selectCategory({ id: first.id, name: first.name, icon: first.icon })
  else {
    primaryId.value = ''
    subId.value = ''
    expandedId.value = ''
  }
}

/** 切换支出 / 收入：分类体系不同，必须清掉上一个类型的选择后重选 */
function switchType(key) {
  if (type.value === key) return
  type.value = key
  selectFirstPrimary()
}

/**
 * 分类兜底：清掉「指向已删除分类」的选中项，并回退到当前类型的第一个一级分类。
 *
 * 为什么需要：分类是**可删的**（「分类管理」页），而选中项有两个来源都会带上
 * 历史 id ——
 *   ① 草稿：去「分类管理」改完分类再返回记账页时恢复（见 useRecordDraft）；
 *   ② 编辑既有账单：`bill.primaryCategoryId`。
 * 分类被删掉之后这两个 id 就悬空了，宫格会**一个都不高亮**，
 * 表现就是「没有默认分类」；用户接着点保存还会莫名收到「请选择分类」。
 *
 * 注意降级顺序：先清二级/展开项，最后才回退一级 ——
 * `selectFirstPrimary()` 会整体重设三者。
 */
function normalizeSelection() {
  const alive = (id) => Boolean(id && categoryStore.byId[id])
  if (!alive(subId.value)) subId.value = ''
  if (!alive(expandedId.value)) expandedId.value = ''
  if (!alive(primaryId.value)) selectFirstPrimary()
}

function selectCategory(item) {
  if (item.id === '__manage__') {
    router.push({ path: '/category', query: { type: type.value } })
    return
  }
  const hasChild = categoryStore.hasChildren(item.id)
  primaryId.value = item.id
  subId.value = ''
  expandedId.value = hasChild ? item.id : ''
}

function selectSub(item) {
  subId.value = item.id
  primaryId.value = item.parentId || primaryId.value
}

function goAddSub() {
  router.push({
    path: '/category/edit',
    query: { scope: 'secondary', parentId: expandedId.value, type: type.value }
  })
}

const opHint = computed(() => {
  if (!op.value) return ''
  return `${acc.value} ${op.value}`
})

function currentValue() {
  if (cur.value === '') return null
  const n = Number(cur.value)
  return Number.isFinite(n) ? n : null
}

function commitOperator() {
  const value = currentValue()
  if (op.value && value !== null) {
    acc.value = round2(op.value === '+' ? acc.value + value : acc.value - value)
  } else if (value !== null) {
    acc.value = round2(value)
  }
  op.value = null
  cur.value = ''
}

function resolveAmount() {
  const value = currentValue()
  if (op.value && value !== null) {
    return toAmount(op.value === '+' ? acc.value + value : acc.value - value)
  }
  if (value !== null) return toAmount(value)
  return toAmount(acc.value)
}

function resetAmount() {
  acc.value = 0
  op.value = null
  cur.value = ''
}

function onKey(key) {
  if (/^\d$/.test(key)) {
    const [, dec] = cur.value.split('.')
    if (dec !== undefined && dec.length >= 2) return
    if (cur.value.replace('.', '').length >= 9) return
    cur.value += key
    return
  }
  if (key === '.') {
    if (cur.value.includes('.')) return
    cur.value = cur.value === '' ? '0.' : `${cur.value}.`
    return
  }
  if (key === 'backspace') {
    cur.value = cur.value.slice(0, -1)
    return
  }
  if (key === '+' || key === '-') {
    commitOperator()
    op.value = key
    return
  }
  if (key === 'again') {
    submit(true)
    return
  }
  if (key === 'done') submit(false)
}

/* ---------------- 草稿：离开页面不丢编辑内容 ---------------- */

/** 把当前表单状态落盘（任一字段变化即写入，刷新/误关页面也能恢复） */
function persistDraft() {
  writeRecordDraft({
    type: type.value,
    primaryId: primaryId.value,
    subId: subId.value,
    expandedId: expandedId.value,
    remark: remark.value,
    dateKey: dateKey.value,
    acc: acc.value,
    op: op.value || '',
    cur: cur.value,
    editingId: editingId.value
  })
}

/** 用草稿覆盖表单状态 */
function applyDraft(draft) {
  type.value = draft.type || 'expense'
  primaryId.value = draft.primaryId || ''
  subId.value = draft.subId || ''
  expandedId.value = draft.expandedId || ''
  remark.value = draft.remark || ''
  dateKey.value = draft.dateKey || todayKey()
  acc.value = Number(draft.acc) || 0
  op.value = draft.op || null
  cur.value = draft.cur || ''
  editingId.value = draft.editingId || ''
}

/* ---------------- 备注候选 ---------------- */
async function loadRemarkSuggestions() {
  const id = currentCategoryId.value
  if (!id) {
    remarkSuggestions.value = []
    return
  }
  try {
    remarkSuggestions.value = await billStore.remarkHistory(id)
  } catch (e) {
    remarkSuggestions.value = []
  }
}

/* ---------------- 提交 ---------------- */
async function submit(again) {
  const amount = resolveAmount()
  const categoryId = subId.value || primaryId.value

  if (!categoryId) {
    toast.error('请选择分类')
    return
  }
  if (amount <= 0) {
    toast.error('请输入金额')
    return
  }

  try {
    const payload = {
      type: type.value,
      amount,
      categoryId,
      remark: remark.value,
      date: dateKey.value
    }
    if (editingId.value) {
      await billStore.updateBill(editingId.value, payload)
      clearRecordDraft()
      toast.success('修改成功')
      goBack()
      return
    }
    await billStore.createBill(payload)
    // 已落库，草稿使命结束
    clearRecordDraft()
    // 新备注进入候选，下次填这个分类时能直接选
    await loadRemarkSuggestions()
    toast.success('记账成功')
    if (again) {
      resetAmount()
      remark.value = ''
      persistDraft()
      toast.show('已保存，继续记账')
      return
    }
    goBack()
  } catch (e) {
    toast.error(e?.message || '保存失败')
  }
}

function goBack() {
  const back = router.options.history.state?.back
  if (back) router.back()
  else router.push({ path: '/' })
}

async function removeBill() {
  if (!editingId.value) return
  await billStore.deleteBill(editingId.value)
  clearRecordDraft()
  toast.success('已删除')
  goBack()
}

/* ---------------- 初始化 ---------------- */
onMounted(async () => {
  loading.value = true
  await Promise.all([ledgerStore.ensureLoaded(), categoryStore.ensureLoaded()])
  await billStore.ensureLoaded()

  const id = route.query.id
  const queryType = route.query.type
  if (queryType && TYPES.some((t) => t.key === queryType)) type.value = queryType

  // 草稿恢复：只有「从分类管理 / 分类编辑返回」这一种进入方式会留下草稿
  // （路由守卫负责在其它进入方式时清空，见 installRecordDraftGuard）。
  // 另外校验 editingId —— 换了一笔账单就必须重新读取，不能套用旧草稿。
  const draft = readRecordDraft()
  if (draft && String(draft.editingId || '') === String(id || '')) {
    applyDraft(draft)
    // 草稿里的分类可能已经在上次「分类管理」里被删掉，兜底回退
    normalizeSelection()
  } else if (id) {
    const bill = await billStore.getBill(id)
    if (bill) {
      editingId.value = bill.id
      type.value = bill.type === 'income' ? 'income' : 'expense'
      primaryId.value = bill.primaryCategoryId || ''
      subId.value = ''
      expandedId.value = ''
      if (bill.categoryId && bill.categoryId !== bill.primaryCategoryId) {
        subId.value = bill.categoryId
        expandedId.value = bill.primaryCategoryId || ''
      }
      acc.value = bill.amount
      cur.value = ''
      op.value = null
      remark.value = bill.remark || ''
      dateKey.value = bill.date || todayKey()
      // 这笔账引用的分类可能已被删除（悬空 id），兜底回退
      normalizeSelection()
    } else {
      toast.error('账单不存在')
    }
  } else {
    // 新建一笔且没有草稿：默认选中第一个一级分类（如「餐饮」）
    selectFirstPrimary()
  }

  await loadRemarkSuggestions()
  persistDraft()
  loading.value = false
})

/* 表单任一字段变化立即落盘，保证切页面 / 刷新 / 误关都不丢编辑内容 */
watch(
  [type, primaryId, subId, expandedId, remark, dateKey, acc, op, cur, editingId],
  () => {
    if (loading.value) return
    persistDraft()
  },
  { flush: 'post' }
)

/* 切换分类后重新拉取该分类下的历史备注 */
watch(currentCategoryId, () => {
  loadRemarkSuggestions()
})

/* 分类列表整体刷新后（刚在「分类管理」里增删过分类）再兜一次底：
   当前选中的分类若已消失，立即回退到第一个，
   绝不让宫格停在「一个都没高亮」的状态 */
watch(primaries, () => {
  if (loading.value) return
  normalizeSelection()
})
</script>

<template>
  <div class="page record-page">
    <AppHeader :back="true" transparent>
      <template #left>
        <button class="icon-btn" aria-label="返回" @click="goBack">
          <IconBase name="back" :size="22" />
        </button>
      </template>
      <template #default>
        <nav class="type-tabs">
          <button
            v-for="item in TYPES"
            :key="item.key"
            class="type-tab"
            :class="{ 'is-active': type === item.key }"
            type="button"
            @click="switchType(item.key)"
          >
            <span>{{ item.label }}</span>
            <i v-if="type === item.key" class="line" />
          </button>
        </nav>
      </template>
      <template #right>
        <button v-if="editingId" class="icon-btn" aria-label="删除" @click="confirmOpen = true">
          <IconBase name="trash" :size="20" />
        </button>
      </template>
    </AppHeader>

    <div class="page-body record-body">
      <CategoryGrid
        :items="items"
        :selected-id="subId"
        :active-id="primaryId"
        :badges="badges"
        :insert-after-id="expandedId"
        @select="selectCategory"
      >
        <template #insert>
          <SubCategoryPanel
            :items="expandedChildren"
            :selected-id="subId"
            @select="selectSub"
            @add="goAddSub"
          />
        </template>
      </CategoryGrid>
    </div>

    <RecordPanel
      v-model:remark="remark"
      v-model:date-key="dateKey"
      :amount-text="amountText"
      :ledger-name="ledgerStore.currentName"
      :remark-suggestions="remarkSuggestions"
      @key="onKey"
    >
    </RecordPanel>

    <ConfirmDialog
      v-model="confirmOpen"
      title="删除这笔账单？"
      message="删除后将从账目中移除。如需找回，可用「我的 → 数据备份」中此前导出的备份恢复。"
      confirm-text="删除"
      danger
      @confirm="removeBill"
    />
  </div>
</template>

<style scoped>
.record-page {
  background: var(--page);
}

/* 与参考稿一致：分类区直接铺在灰色页面上，
   二级分类面板作为白色浮起卡片（见 SubCategoryPanel.vue）叠在灰底之上 */
.record-body {
  background: transparent;
  padding: 8px 6px 8px;
}

.type-tabs {
  display: flex;
  align-items: center;
  gap: 20px;
  height: 100%;
}

.type-tab {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  height: 100%;
  justify-content: center;
  font-size: 15.5px;
  color: var(--ink-3);
  font-weight: 400;
}

.type-tab.is-active {
  color: var(--ink);
  font-weight: 600;
}

.type-tab .line {
  position: absolute;
  bottom: 6px;
  left: 50%;
  transform: translateX(-50%);
  width: 22px;
  height: 3px;
  border-radius: 2px;
  background: var(--brand);
}
</style>
