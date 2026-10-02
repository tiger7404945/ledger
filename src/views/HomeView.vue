<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useBillStore } from '@/stores/bill.js'
import { useLedgerStore } from '@/stores/ledger.js'
import { useCategoryStore } from '@/stores/category.js'
import AppHeader from '@/components/AppHeader.vue'
import IconBase from '@/components/icons/IconBase.vue'
import TabBar from '@/components/TabBar.vue'
import BillRow from '@/components/BillRow.vue'
import AmountText from '@/components/AmountText.vue'
import SearchOverlay from '@/components/SearchOverlay.vue'
import { formatDateCN, monthFirstKey, currentMonthKey, daysInMonth } from '@/utils/date.js'

const router = useRouter()
const billStore = useBillStore()
const ledgerStore = useLedgerStore()
const categoryStore = useCategoryStore()

const searchOpen = ref(false)

const summary = computed(() => billStore.summary)
const todayBills = computed(() => billStore.todayBills)
const todayStat = computed(() => billStore.todayStat)

const rangeLabel = computed(() => {
  const month = summary.value.month || currentMonthKey()
  const last = daysInMonth(month)
  return `${formatDateCN(monthFirstKey(month))}-${formatDateCN(`${month}-${last}`)}`
})

/**
 * 总览区底部的三个统计口径。放在一处算，模板只负责渲染 ——
 * 「本月结余」= 本月收入 − 本月支出（口径由数据层 `summarizeBills` 定，
 * 见 `api/core/query.js`，前端不自己减一遍）。
 */
const heroStats = computed(() => [
  { key: 'income', label: '本月收入', value: summary.value.income },
  { key: 'balance', label: '本月结余', value: summary.value.balance },
  { key: 'dailyAvg', label: '日均支出', value: summary.value.dailyAvg }
])

onMounted(async () => {
  await Promise.all([ledgerStore.ensureLoaded(), categoryStore.ensureLoaded()])
  await billStore.ensureLoaded()
})

function openBill(bill) {
  router.push({ path: '/record', query: { id: bill.id } })
}
</script>

<template>
  <div class="page home-page">
    <AppHeader>
      <button class="ledger" type="button" @click="router.push('/bills')">
        {{ ledgerStore.currentName }}
        <IconBase name="swap" :size="16" :stroke-width="1.7" />
      </button>
      <template #right>
        <button class="icon-btn" aria-label="搜索" @click="searchOpen = true">
          <IconBase name="search" :size="21" />
        </button>
      </template>
    </AppHeader>

    <div class="page-body">
      <!-- 本月总览 -->
      <section class="hero">
        <span class="hero-label">本月支出</span>
        <span class="hero-range">{{ rangeLabel }}</span>
        <div class="hero-amount">
          <AmountText :value="summary.expense" :size="36" :weight="700" space />
        </div>
        <div class="hero-foot">
          <div v-for="stat in heroStats" :key="stat.key" class="hero-stat">
            <em>{{ stat.label }}</em>
            <b>¥ {{ stat.value.toFixed(2) }}</b>
          </div>
        </div>
      </section>

      <!-- 今日账单 -->
      <section class="card today-card">
        <header class="today-head">
          <span class="section-title">今日账单</span>
          <span class="today-stat">
            <em>收入 {{ todayStat.income.toFixed(2) }}</em>
            <em class="expense">支出 {{ todayStat.expense.toFixed(2) }}</em>
          </span>
        </header>

        <div class="today-list">
          <BillRow v-for="bill in todayBills" :key="bill.id" :bill="bill" @click="openBill" />
          <p v-if="!todayBills.length" class="empty">今天还没有记账</p>
        </div>

        <button class="more" type="button" @click="router.push('/bills')">
          更多明细
          <IconBase name="chevronRight" :size="13" :stroke-width="2" />
        </button>
      </section>

      <!-- 分类入口（原「添加卡片 / 编辑首页」两个入口已按产品决定合并） -->
      <div class="quick-row">
        <button class="quick" type="button" @click="router.push('/category')">
          <IconBase name="edit" :size="15" />
          编辑分类
        </button>
      </div>
    </div>

    <TabBar />
    <SearchOverlay v-model="searchOpen" />
  </div>
</template>

<style scoped>
.home-page {
  background: var(--page);
}

.ledger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 17px;
  font-weight: 500;
  color: var(--ink);
}

.page-body {
  /* 底部留出标签栏高度，否则最后一屏内容会被固定的 TabBar 盖住 */
  padding: 0 14px var(--tabbar-space);
}

/* ---------- 本月总览 ---------- */
.hero {
  position: relative;
  margin-top: 4px;
  padding: 18px 18px 16px;
  border-radius: var(--r-lg);
  background: var(--brand-grad);
  color: #fff;
  overflow: hidden;
}

.hero::after {
  content: '';
  position: absolute;
  right: -60px;
  top: -70px;
  width: 240px;
  height: 240px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.09);
}

.hero::before {
  content: '';
  position: absolute;
  right: 30px;
  bottom: -110px;
  width: 220px;
  height: 220px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.07);
}

.hero-label {
  font-size: 13px;
  color: var(--on-brand-dim);
}

.hero-range {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 1;
  padding: 4px 10px;
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.95);
  color: var(--brand-ink);
  font-size: 11.5px;
}

.hero-amount {
  margin: 10px 0 14px;
  font-weight: 700;
}

/* 总览底部统计：三列等宽，标签在上、金额在下。
   原来是「本月收入 / 日均支出」挤在一行 —— 加上「本月结余」后一行
   装不下三个「¥ 12,000.00」（会溢出/换行），所以改成三列 + 顶部细分隔线。 */
.hero-foot {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-top: 16px;
  padding-top: 13px;
  border-top: 1px solid rgba(255, 255, 255, 0.22);
}

.hero-stat {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.hero-stat em {
  font-style: normal;
  font-size: 11.5px;
  color: var(--on-brand-dim);
}

.hero-stat b {
  font-family: var(--font-num);
  font-size: 12.5px;
  font-weight: 600;
  color: #fff;
  white-space: nowrap;
  letter-spacing: -0.2px;
}

/* ---------- 今日账单 ---------- */
.today-card {
  display: flex;
  flex-direction: column;
  min-height: 220px;
  margin-top: 12px;
  padding: 16px 16px 10px;
}

.today-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.today-stat {
  display: flex;
  gap: 10px;
  font-size: 12.5px;
  color: var(--ink-2);
}

.today-stat em {
  font-style: normal;
}

.today-stat .expense {
  color: var(--ink);
}

.today-list {
  flex: 1;
  padding-top: 6px;
}

.empty {
  margin: 28px 0;
  text-align: center;
  font-size: 13px;
  color: var(--ink-4);
}

.more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  height: 38px;
  color: var(--brand-700);
  font-size: 12.5px;
}

/* ---------- 次要入口 ---------- */
.quick-row {
  display: flex;
  justify-content: center;
  padding: 20px 0 8px;
}

.quick {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12.5px;
  color: var(--ink-3);
}
</style>
