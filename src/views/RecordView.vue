<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useCategoryStore } from '@/stores/category.js'
import { useBillStore } from '@/stores/bill.js'
import { useLedgerStore } from '@/stores/ledger.js'
import { useToast } from '@/composables/useToast.js'
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

const TYPES = [
  { key: 'expense', label: '支出' },
  { key: 'income', label: '收入' },
  { key: 'transfer', label: '转账' },
  { key: 'lending', label: '借贷' }
]

const MANAGE_ENTRY = { id: '__manage__', name: '分类管理', icon: 'settings' }

/* ---------------- 表单状态 ---------------- */
const type = ref('expense')
const primaryId = ref('')
const subId = ref('')
const expandedId = ref('')
const remark = ref('')
const dateKey = ref(todayKey())
const noReimburse = ref(false)
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

/* ---------------- 交互 ---------------- */
/** 切换支出/收入/转账/借贷：分类体系不同，必须清掉上一个类型的选择 */
function switchType(key) {
  if (type.value === key) return
  type.value = key
  primaryId.value = ''
  subId.value = ''
  expandedId.value = ''
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

function onAction(name) {
  if (name === 'account') toast.show('资产账户将在后续版本支持')
  if (name === 'image') toast.show('图片附件将在后续版本支持')
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
      type: type.value === 'transfer' || type.value === 'lending' ? 'expense' : type.value,
      amount,
      categoryId,
      remark: remark.value,
      date: dateKey.value,
      noReimburse: noReimburse.value
    }
    if (editingId.value) {
      await billStore.updateBill(editingId.value, payload)
      toast.success('修改成功')
      goBack()
      return
    }
    await billStore.createBill(payload)
    toast.success('记账成功')
    if (again) {
      resetAmount()
      remark.value = ''
      toast.show('已保存，继续记账')
      return
    }
    goBack()
  } catch (e) {
    toast.error(e?.message || '保存失败')
  }
}

function resetForm() {
  resetAmount()
  remark.value = ''
  noReimburse.value = false
  primaryId.value = ''
  subId.value = ''
  expandedId.value = ''
}

function goBack() {
  const back = router.options.history.state?.back
  if (back) router.back()
  else router.push({ path: '/' })
}

async function removeBill() {
  if (!editingId.value) return
  await billStore.deleteBill(editingId.value)
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

  if (id) {
    const bill = await billStore.getBill(id)
    if (bill) {
      editingId.value = bill.id
      type.value = bill.type === 'income' ? 'income' : 'expense'
      primaryId.value = bill.primaryCategoryId || ''
      if (bill.categoryId && bill.categoryId !== bill.primaryCategoryId) {
        subId.value = bill.categoryId
        expandedId.value = bill.primaryCategoryId || ''
      }
      acc.value = bill.amount
      cur.value = ''
      op.value = null
      remark.value = bill.remark || ''
      dateKey.value = bill.date || todayKey()
      noReimburse.value = !!bill.noReimburse
    } else {
      toast.error('账单不存在')
    }
  }
  loading.value = false
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
      v-model:no-reimburse="noReimburse"
      :amount-text="amountText"
      :ledger-name="ledgerStore.currentName"
      @key="onKey"
      @action="onAction"
    >
    </RecordPanel>

    <ConfirmDialog
      v-model="confirmOpen"
      title="删除这笔账单？"
      message="删除后可在后续的云端同步中恢复（本地立即移除）。"
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
