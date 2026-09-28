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
 * 净资产 = 各资产账户余额之和。
 * 第一阶段不建模「资产账户」，因此固定为 0（与参考设计一致）；
 * 接入账户体系后改为从 accountRepository 汇总。
 */
const netAsset = computed(() => 0)

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

    <div class="page-body has-tabbar">
      <!-- 本月总览 -->
      <section class="hero">
        <span class="hero-label">本月支出</span>
        <span class="hero-range">{{ rangeLabel }}</span>
        <div class="hero-amount">
          <AmountText :value="summary.expense" :size="36" :weight="700" space />
        </div>
        <div class="hero-foot">
          <span>本月收入 ¥ {{ summary.income.toFixed(2) }}</span>
          <span>日均支出 ¥ {{ summary.dailyAvg.toFixed(2) }}</span>
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

      <!-- 自动记账 / 净资产 -->
      <div class="mini-row">
        <section class="card mini">
          <div class="mini-head">
            <i class="bar" />
            <span>自动记账</span>
          </div>
          <span class="mini-pill">未开启</span>
        </section>
        <section class="card mini">
          <div class="mini-head">
            <i class="bar" />
            <span>净资产</span>
          </div>
          <AmountText class="mini-amount" :value="netAsset" :size="22" :weight="600" />
        </section>
      </div>

      <div class="quick-row">
        <button class="quick" type="button" @click="router.push('/category')">
          <IconBase name="plus" :size="15" />
          添加卡片
        </button>
        <button class="quick" type="button" @click="router.push('/category')">
          <IconBase name="edit" :size="15" />
          编辑首页
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
  padding: 0 14px;
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

.hero-foot {
  display: flex;
  gap: 18px;
  font-size: 12.5px;
  color: var(--on-brand-dim);
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

/* ---------- 小卡片 ---------- */
.mini-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 12px;
}

.mini {
  padding: 14px 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 92px;
}

.mini-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13.5px;
  color: var(--ink);
}

.bar {
  width: 3px;
  height: 12px;
  border-radius: 2px;
  background: var(--brand);
}

.mini-pill {
  align-self: flex-start;
  padding: 3px 10px;
  border-radius: var(--r-pill);
  background: var(--surface-3);
  color: var(--ink-3);
  font-size: 11.5px;
}

.mini-amount {
  margin-top: auto;
}

.quick-row {
  display: flex;
  justify-content: center;
  gap: 40px;
  padding: 22px 0 8px;
}

.quick {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12.5px;
  color: var(--ink-3);
}
</style>
