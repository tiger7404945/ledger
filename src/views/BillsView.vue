<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useBillStore } from '@/stores/bill.js'
import { useLedgerStore } from '@/stores/ledger.js'
import AppHeader from '@/components/AppHeader.vue'
import IconBase from '@/components/icons/IconBase.vue'
import TabBar from '@/components/TabBar.vue'
import BillRow from '@/components/BillRow.vue'
import AmountText from '@/components/AmountText.vue'
import SearchOverlay from '@/components/SearchOverlay.vue'
import PeriodSwitch from '@/components/PeriodSwitch.vue'
import { useSwipeViews } from '@/composables/useSwipeViews.js'
import { formatDateDots, monthGrid, weekdayLabels, todayKey } from '@/utils/date.js'

const router = useRouter()
const billStore = useBillStore()
const ledgerStore = useLedgerStore()

/** 流水 | 日历 —— 可点顶部胶囊切换，也可在列表区左右滑动切换 */
const VIEWS = ['flow', 'calendar']

const searchOpen = ref(false)
const view = ref('flow')
const activeDay = ref('')

const summary = computed(() => billStore.periodSummary)
const groups = computed(() => billStore.periodGroups)
const dailyMap = computed(() => billStore.periodDailyMap)
const monthlyMap = computed(() => billStore.periodMonthlyMap)
const isYear = computed(() => billStore.period.mode === 'year')
const cells = computed(() => monthGrid(billStore.period.month))
const weekdays = weekdayLabels()
const today = todayKey()
/** 年度总览里的 1..12 月 */
const months = Array.from({ length: 12 }, (_, i) => i + 1)

const activeDayBills = computed(() =>
  activeDay.value ? billStore.periodBills.filter((b) => b.date === activeDay.value) : []
)

const calendarExpense = computed(() =>
  Object.values(dailyMap.value).reduce((sum, d) => sum + d.expense, 0)
)
const monthsWithData = computed(() => Object.keys(monthlyMap.value).length)

onMounted(async () => {
  await Promise.all([ledgerStore.ensureLoaded(), billStore.ensurePeriodLoaded()])
})

// 切换月份/年份后，之前选中的「某天」可能已经不在区间里
watch(
  () => [billStore.period.mode, billStore.period.month, billStore.period.year],
  () => {
    activeDay.value = ''
  }
)

/* ---------------- 左右滑动切换流水 / 日历 ---------------- */

const { drag, trackStyle, paneStyle, onTouchStart, onTouchMove, onTouchEnd } = useSwipeViews({
  views: VIEWS,
  current: view
})

/* ---------------- 事件 ---------------- */

function openBill(bill) {
  router.push({ path: '/record', query: { id: bill.id } })
}

function monthValue(day) {
  return day.slice(8, 10)
}

/** 年度总览点某个月 → 下钻到该月（按月查看） */
function drillToMonth(m) {
  billStore.setPeriodMonth(`${billStore.period.year}-${String(m).padStart(2, '0')}`)
}

function monthExpense(m) {
  const key = `${billStore.period.year}-${String(m).padStart(2, '0')}`
  return monthlyMap.value[key]?.expense || 0
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

    <div class="page-body">
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

        <PeriodSwitch />
      </div>

      <!-- 结余卡片 -->
      <section class="hero">
        <span class="hero-label">{{ isYear ? '本年结余' : '结余' }}</span>
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
            <span class="k">{{ billStore.periodUnit }}支出</span>
            <span class="v">¥ {{ summary.expense.toFixed(2) }}</span>
          </div>
          <div class="hero-cell">
            <span class="k">{{ billStore.periodUnit }}收入</span>
            <span class="v">¥ {{ summary.income.toFixed(2) }}</span>
          </div>
          <div class="hero-cell">
            <span class="k">{{ billStore.periodUnit }}预算</span>
            <span class="v">¥ {{ summary.budget.toFixed(2) }}</span>
          </div>
          <div class="hero-cell">
            <span class="k">{{ billStore.periodUnit }}剩余</span>
            <span class="v">¥ {{ summary.remain.toFixed(2) }}</span>
          </div>
        </div>
      </section>

      <!--
        左右滑动切换流水/日历：两屏并排放在一条轨道上，拖动时跟手位移，松手后吸附。
        每一屏各有自己的滚动区，只有列表被滚动。
      -->
      <div
        class="view-track"
        :class="{ 'is-dragging': drag.active }"
        :style="trackStyle"
        @touchstart="onTouchStart"
        @touchmove="onTouchMove"
        @touchend="onTouchEnd"
        @touchcancel="onTouchEnd"
      >
        <!-- 流水视图 -->
        <div class="view-pane" :style="paneStyle">
          <div class="scroll-area">
            <section class="card list-card">
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
              <p v-if="!groups.length" class="empty">
                {{ isYear ? '这一年还没有账单' : '本月还没有账单' }}
              </p>
            </section>
          </div>
        </div>

        <!-- 日历视图 -->
        <div class="view-pane" :style="paneStyle">
          <div class="scroll-area">
            <!-- 按月：月历 + 当日明细 -->
            <section v-if="!isYear" class="card calendar-card">
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
                    <em class="expense">
                      支 ¥ {{ (dailyMap[activeDay]?.expense || 0).toFixed(2) }}
                    </em>
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

            <!-- 按年：12 个月的年度总览，点某月下钻到该月 -->
            <section v-else class="card calendar-card">
              <div class="year-head">
                <span class="section-title">{{ billStore.period.year }}年各月支出</span>
                <span class="muted">{{ monthsWithData }} 个月有记账</span>
              </div>
              <div class="year-grid">
                <button
                  v-for="m in months"
                  :key="m"
                  class="month-cell"
                  :class="{ 'has-data': monthExpense(m) > 0 }"
                  type="button"
                  @click="drillToMonth(m)"
                >
                  <span class="d">{{ m }}月</span>
                  <span class="amt">{{ monthExpense(m) ? monthExpense(m).toFixed(0) : '—' }}</span>
                </button>
              </div>
              <div class="calendar-foot">
                本年支出 <b>¥ {{ calendarExpense.toFixed(2) }}</b>
              </div>
            </section>
          </div>
        </div>
      </div>
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
  /* 本页由内部的 .scroll-area 负责滚动，本层只做纵向排布 */
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ---------- 筛选行 ---------- */
.filter-row {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 14px;
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

/* 账期切换器的样式在 components/PeriodSwitch.vue 里，两页共用 */

/* ---------- 流水 / 日历 滑动轨道 ---------- */
/* 轨道宽度与每屏宽度由 useSwipeViews 绑定的行内样式给出，这里只管排布与过渡 */
.view-track {
  flex: 1;
  min-height: 0;
  display: flex;
  transition: transform 0.26s cubic-bezier(0.22, 0.61, 0.36, 1);
}

/* 拖动跟手时不要过渡 */
.view-track.is-dragging {
  transition: none;
}

.view-pane {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ---------- 结余卡片 ---------- */
.hero {
  position: relative;
  flex: none;
  margin: 0 14px 12px;
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

/* ---------- 列表滚动区 ---------- */
/*
 * 页面里只有这一块滚动；底部预留 --tabbar-space，
 * 保证最后一条记录能完整滚到固定标签栏之上（此前被盖住、也没法滚出来）。
 */
.scroll-area {
  padding: 0 14px var(--tabbar-space);
}

/* ---------- 列表 ---------- */
.list-card {
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

/* ---------- 日历 · 按年总览 ---------- */
.year-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 2px 2px 12px;
}

.year-head .muted {
  font-size: 12px;
}

.year-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.month-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: 52px;
  border-radius: var(--r-sm);
  background: var(--surface-2);
  transition: background 0.15s ease;
}

.month-cell .d {
  font-size: 13.5px;
  color: var(--ink-3);
}

.month-cell .amt {
  font-size: 12.5px;
  font-family: var(--font-num);
  color: var(--ink-4);
}

.month-cell.has-data {
  background: var(--brand-soft);
}

.month-cell.has-data .d {
  color: var(--ink);
}

.month-cell.has-data .amt {
  color: var(--brand-ink);
}

.month-cell:active {
  background: var(--brand-soft-2);
}
</style>
