<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useBillStore } from '@/stores/bill.js'
import { useLedgerStore } from '@/stores/ledger.js'
import AppHeader from '@/components/AppHeader.vue'
import IconBase from '@/components/icons/IconBase.vue'
import TabBar from '@/components/TabBar.vue'
import BillRow from '@/components/BillRow.vue'
import AmountText from '@/components/AmountText.vue'
import SearchOverlay from '@/components/SearchOverlay.vue'
import {
  formatDateDots,
  formatMonthLabel,
  monthGrid,
  weekdayLabels,
  todayKey
} from '@/utils/date.js'

const router = useRouter()
const billStore = useBillStore()
const ledgerStore = useLedgerStore()

const searchOpen = ref(false)
const view = ref('flow')
const activeDay = ref('')

const summary = computed(() => billStore.summary)
const groups = computed(() => billStore.groups)
const dailyMap = computed(() => billStore.dailyMap)
const cells = computed(() => monthGrid(billStore.month))
const weekdays = weekdayLabels()
const today = todayKey()

const activeDayBills = computed(() =>
  activeDay.value ? billStore.bills.filter((b) => b.date === activeDay.value) : []
)

const calendarExpense = computed(() =>
  Object.values(dailyMap.value).reduce((sum, d) => sum + d.expense, 0)
)

onMounted(async () => {
  await Promise.all([ledgerStore.ensureLoaded(), billStore.ensureLoaded()])
})

function openBill(bill) {
  router.push({ path: '/record', query: { id: bill.id } })
}

function monthValue(day) {
  return day.slice(8, 10)
}
</script>

<template>
  <div class="page bills-page">
    <AppHeader>
      <button class="ledger" type="button">
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
      <!-- 筛选行 -->
      <div class="filter-row">
        <div class="segmented">
          <button
            class="seg"
            :class="{ 'is-active': view === 'flow' }"
            type="button"
            @click="view = 'flow'"
          >
            流水
          </button>
          <button
            class="seg"
            :class="{ 'is-active': view === 'calendar' }"
            type="button"
            @click="view = 'calendar'"
          >
            日历
          </button>
        </div>

        <div class="month-switch">
          <button class="arrow" type="button" @click="billStore.shiftMonth(-1)">
            <IconBase name="chevronLeft" :size="15" :stroke-width="2" />
          </button>
          <span class="month-label">{{ formatMonthLabel(billStore.month) }}</span>
          <button class="arrow" type="button" @click="billStore.shiftMonth(1)">
            <IconBase name="chevronRight" :size="15" :stroke-width="2" />
          </button>
        </div>
      </div>

      <!-- 结余卡片 -->
      <section class="hero">
        <span class="hero-label">结余</span>
        <div class="hero-amount">
          <AmountText
            :value="summary.balance"
            :sign="summary.balance < 0 ? '-' : ''"
            :size="30"
            :weight="700"
            space
          />
        </div>
        <div class="hero-grid">
          <div class="hero-cell">
            <span class="k">本月支出</span>
            <span class="v">¥ {{ summary.expense.toFixed(2) }}</span>
          </div>
          <div class="hero-cell">
            <span class="k">本月收入</span>
            <span class="v">¥ {{ summary.income.toFixed(2) }}</span>
          </div>
          <div class="hero-cell">
            <span class="k">本月预算</span>
            <span class="v">¥ {{ summary.budget.toFixed(2) }}</span>
          </div>
          <div class="hero-cell">
            <span class="k">本月剩余</span>
            <span class="v">¥ {{ summary.remain.toFixed(2) }}</span>
          </div>
        </div>
      </section>

      <!-- 流水视图 -->
      <section v-if="view === 'flow'" class="card list-card">
        <template v-for="group in groups" :key="group.date">
          <header class="group-head">
            <span>{{ formatDateDots(group.date) }}</span>
            <span class="group-stat">
              <em>收 ¥ {{ group.income.toFixed(2) }}</em>
              <em class="expense">支 ¥ {{ group.expense.toFixed(2) }}</em>
            </span>
          </header>
          <BillRow
            v-for="bill in group.items"
            :key="bill.id"
            :bill="bill"
            :size="40"
            @click="openBill"
          />
        </template>
        <p v-if="!groups.length" class="empty">本月还没有账单</p>
      </section>

      <!-- 日历视图 -->
      <section v-else class="card calendar-card">
        <div class="week-head">
          <span v-for="w in weekdays" :key="w">{{ w }}</span>
        </div>
        <div class="grid">
          <button
            v-for="(day, index) in cells"
            :key="index"
            class="cell"
            :class="{
              empty: !day,
              'is-today': day === today,
              'is-active': day === activeDay
            }"
            type="button"
            :disabled="!day"
            @click="activeDay = day === activeDay ? '' : day"
          >
            <template v-if="day">
              <span class="d">{{ Number(monthValue(day)) }}</span>
              <span v-if="dailyMap[day]" class="amt">
                {{ dailyMap[day].expense ? dailyMap[day].expense.toFixed(0) : '' }}
              </span>
            </template>
          </button>
        </div>
        <div class="calendar-foot">
          本月支出 <b>¥ {{ calendarExpense.toFixed(2) }}</b>
        </div>

        <div v-if="activeDay" class="day-detail">
          <header class="group-head">
            <span>{{ formatDateDots(activeDay) }}</span>
            <span class="group-stat">
              <em class="expense">支 ¥ {{ (dailyMap[activeDay]?.expense || 0).toFixed(2) }}</em>
            </span>
          </header>
          <BillRow
            v-for="bill in activeDayBills"
            :key="bill.id"
            :bill="bill"
            :size="38"
            @click="openBill"
          />
          <p v-if="!activeDayBills.length" class="empty">当天没有账单</p>
        </div>
      </section>
    </div>

    <TabBar />
    <SearchOverlay v-model="searchOpen" />
  </div>
</template>

<style scoped>
.bills-page {
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

/* ---------- 筛选行 ---------- */
.filter-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 0 12px;
}

.segmented {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-pill);
  background: var(--surface-3);
}

.seg {
  height: 26px;
  padding: 0 14px;
  border-radius: var(--r-pill);
  font-size: 13px;
  color: var(--ink-3);
}

.seg.is-active {
  background: var(--brand);
  color: #fff;
  font-weight: 500;
}

.month-switch {
  display: flex;
  align-items: center;
  gap: 6px;
}

.arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--surface-3);
  color: var(--ink-2);
}

.month-label {
  font-size: 13.5px;
  color: var(--ink);
  min-width: 74px;
  text-align: center;
}

/* ---------- 结余卡片 ---------- */
.hero {
  position: relative;
  padding: 16px 18px 14px;
  border-radius: var(--r-lg);
  background: var(--brand-grad);
  color: #fff;
  overflow: hidden;
}

.hero::after {
  content: '';
  position: absolute;
  right: -70px;
  bottom: -90px;
  width: 220px;
  height: 220px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
}

.hero-label {
  font-size: 13px;
  color: var(--on-brand-dim);
}

.hero-amount {
  margin: 8px 0 16px;
  font-weight: 700;
}

.hero-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  position: relative;
  z-index: 1;
}

.hero-cell {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-left: 10px;
  border-left: 1px solid rgba(255, 255, 255, 0.35);
}

.hero-cell:first-child {
  padding-left: 0;
  border-left: none;
}

.hero-cell .k {
  font-size: 11.5px;
  color: var(--on-brand-dim);
}

.hero-cell .v {
  font-size: 12.5px;
  font-family: var(--font-num);
}

/* ---------- 列表 ---------- */
.list-card {
  margin-top: 12px;
  padding: 4px 16px 10px;
}

.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 8px -16px 2px;
  padding: 8px 16px;
  background: var(--surface-2);
  font-size: 13px;
  color: var(--ink-2);
}

.group-stat {
  display: flex;
  gap: 12px;
  font-size: 12.5px;
}

.group-stat em {
  font-style: normal;
  color: var(--brand-700);
}

.group-stat .expense {
  color: var(--ink);
}

.empty {
  margin: 30px 0;
  text-align: center;
  font-size: 13px;
  color: var(--ink-4);
}

/* ---------- 日历 ---------- */
.calendar-card {
  margin-top: 12px;
  padding: 14px 12px 8px;
}

.week-head {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--ink-3);
  text-align: center;
}

.grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}

.cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  height: 44px;
  border-radius: 8px;
  font-size: 13.5px;
  color: var(--ink);
}

.cell.empty {
  visibility: hidden;
}

.cell .amt {
  font-size: 9.5px;
  color: var(--brand-700);
  font-family: var(--font-num);
}

.cell.is-today {
  color: var(--brand-700);
  font-weight: 600;
}

.cell.is-active {
  background: var(--brand);
  color: #fff;
}

.cell.is-active .amt {
  color: rgba(255, 255, 255, 0.9);
}

.calendar-foot {
  margin: 10px 2px 4px;
  padding-top: 10px;
  border-top: 1px solid var(--hairline);
  font-size: 12.5px;
  color: var(--ink-3);
}

.calendar-foot b {
  color: var(--ink);
  font-family: var(--font-num);
}

.day-detail {
  margin-top: 6px;
}

.day-detail .group-head {
  margin: 8px -12px 2px;
  padding: 8px 12px;
}
</style>
