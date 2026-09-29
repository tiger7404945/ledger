<script setup>
/**
 * 统计页
 *
 * 当期由右上角账期选择器决定（与账单页共用同一份「当期」，可切按月 / 按年）：
 * - 页头：当期总体支出、收入、结余
 * - 趋势卡：折线图，按月账期一天一个点、按年账期一个月一个点，可滑动 / 点按查看单点数据
 * - 排行卡：分类排行，默认前 3 项，可展开
 * - 支出 / 收入 两屏并排在横向轨道上，点胶囊或左右滑动切换
 */
import { computed, onMounted, ref } from 'vue'
import { useBillStore } from '@/stores/bill.js'
import { useCategoryStore } from '@/stores/category.js'
import { useLedgerStore } from '@/stores/ledger.js'
import AppHeader from '@/components/AppHeader.vue'
import TabBar from '@/components/TabBar.vue'
import AmountText from '@/components/AmountText.vue'
import PeriodSwitch from '@/components/PeriodSwitch.vue'
import TrendChart from '@/components/TrendChart.vue'
import RankList from '@/components/RankList.vue'
import { useSwipeViews } from '@/composables/useSwipeViews.js'

/** 支出 | 收入 */
const VIEWS = ['expense', 'income']
const META = {
  expense: { label: '支出', rankTitle: '支出排行', empty: '当期还没有支出记录' },
  income: { label: '收入', rankTitle: '收入排行', empty: '当期还没有收入记录' }
}

const billStore = useBillStore()
const categoryStore = useCategoryStore()
const ledgerStore = useLedgerStore()

const view = ref('expense')

const { drag, trackStyle, paneStyle, onTouchStart, onTouchMove, onTouchEnd } = useSwipeViews({
  views: VIEWS,
  current: view
})

const summary = computed(() => billStore.periodSummary)
const isYear = computed(() => billStore.period.mode === 'year')
/** 本月 / 本年 */
const periodUnit = computed(() => billStore.periodUnit)
/** 折线的粒度：按月账期一天一个点，按年账期一个月一个点 */
const granularity = computed(() => (isYear.value ? '按月' : '按天'))

/** 折线图数据：同一批桶拆成支出 / 收入两条序列 */
const trend = computed(() => {
  const buckets = billStore.periodTrend
  return {
    expense: buckets.map((b) => ({ ...b, value: b.expense })),
    income: buckets.map((b) => ({ ...b, value: b.income }))
  }
})

/** 排行的展示名与图标来自分类 store */
const ranks = computed(() => {
  const source = billStore.periodRankMap
  const decorate = (list) =>
    list.map((item) => {
      const cat = categoryStore.byId[item.id]
      return { ...item, name: cat ? cat.name : '未分类', icon: cat ? cat.icon : 'more' }
    })
  return { expense: decorate(source.expense), income: decorate(source.income) }
})

const counts = computed(() => ({
  expense: ranks.value.expense.reduce((sum, item) => sum + item.count, 0),
  income: ranks.value.income.reduce((sum, item) => sum + item.count, 0)
}))

const totals = computed(() => ({ expense: summary.value.expense, income: summary.value.income }))

onMounted(async () => {
  await Promise.all([
    ledgerStore.ensureLoaded(),
    categoryStore.ensureLoaded(),
    billStore.ensurePeriodLoaded()
  ])
})
</script>

<template>
  <div class="page stats-page">
    <AppHeader title="统计">
      <template #right>
        <PeriodSwitch />
      </template>
    </AppHeader>

    <div class="page-body">
      <!-- 当期总体支出 / 收入 / 结余 -->
      <section class="hero">
        <span class="hero-label">{{ periodUnit }}概览</span>
        <div class="hero-grid">
          <div class="hero-cell">
            <span class="k">支出</span>
            <AmountText :value="summary.expense" :size="17" :weight="600" />
          </div>
          <div class="hero-cell">
            <span class="k">收入</span>
            <AmountText :value="summary.income" :size="17" :weight="600" />
          </div>
          <div class="hero-cell">
            <span class="k">结余</span>
            <AmountText
              :value="summary.balance"
              :sign="summary.balance < 0 ? '-' : ''"
              :size="17"
              :weight="600"
            />
          </div>
        </div>
      </section>

      <!-- 支出 / 收入 视图切换 -->
      <div class="filter-row">
        <div class="segmented">
          <button
            v-for="key in VIEWS"
            :key="key"
            class="seg"
            :class="{ 'is-active': view === key }"
            type="button"
            @click="view = key"
          >
            {{ META[key].label }}
          </button>
        </div>
        <span class="count">共 {{ counts[view] }} 笔</span>
      </div>

      <!-- 支出 / 收入 两屏横向轨道：点胶囊或左右滑动切换 -->
      <div
        class="view-track"
        :class="{ 'is-dragging': drag.active }"
        :style="trackStyle"
        @touchstart="onTouchStart"
        @touchmove="onTouchMove"
        @touchend="onTouchEnd"
        @touchcancel="onTouchEnd"
      >
        <div v-for="key in VIEWS" :key="key" class="view-pane" :style="paneStyle">
          <div class="scroll-area">
            <!-- 趋势 -->
            <section class="card trend-card">
              <header class="card-head">
                <span class="section-title">{{ META[key].label }}趋势</span>
                <span class="muted">{{ granularity }}</span>
              </header>
              <TrendChart
                :points="trend[key]"
                :tone="key"
                :empty-text="META[key].empty"
              />
              <footer class="card-foot">
                <span class="total">
                  合计 <b>¥ {{ totals[key].toFixed(2) }}</b>
                </span>
                <span class="hint">点击或滑动查看单{{ isYear ? '月' : '日' }}数据</span>
              </footer>
            </section>

            <!-- 分类排行 -->
            <RankList
              :title="META[key].rankTitle"
              :items="ranks[key]"
              :empty-text="META[key].empty"
            />
          </div>
        </div>
      </div>
    </div>

    <TabBar />
  </div>
</template>

<style scoped>
.stats-page {
  background: var(--page);
}

.page-body {
  /* 本页由内部的 .scroll-area 负责滚动，本层只做纵向排布 */
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 右上角账期选择器的样式在 components/PeriodSwitch.vue 里，两页共用 */

/* ---------- 当期概览 ---------- */
.hero {
  position: relative;
  flex: none;
  margin: 0 14px 12px;
  padding: 14px 18px;
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
  font-size: 12.5px;
  color: var(--on-brand-dim);
}

.hero-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  position: relative;
  z-index: 1;
  margin-top: 10px;
}

.hero-cell {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-left: 12px;
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

/* ---------- 视图切换行 ---------- */
.filter-row {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 14px;
  padding: 0 0 12px;
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
  padding: 0 18px;
  border-radius: var(--r-pill);
  font-size: 13px;
  color: var(--ink-3);
}

.seg.is-active {
  background: var(--brand);
  color: #fff;
  font-weight: 500;
}

.count {
  font-size: 12.5px;
  color: var(--ink-3);
}

/* ---------- 支出 / 收入 滑动轨道 ---------- */
/* 轨道宽度与每屏宽度由 useSwipeViews 绑定的行内样式给出 */
.view-track {
  flex: 1;
  min-height: 0;
  display: flex;
  transition: transform 0.26s cubic-bezier(0.22, 0.61, 0.36, 1);
}

.view-track.is-dragging {
  transition: none;
}

.view-pane {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.scroll-area {
  padding: 0 14px var(--tabbar-space);
}

/* ---------- 趋势卡 ---------- */
.trend-card {
  padding: 14px 14px 10px;
}

.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 2px;
}

.muted {
  font-size: 12px;
  color: var(--ink-3);
}

.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--hairline);
  font-size: 12px;
  color: var(--ink-3);
}

.card-foot .total b {
  color: var(--ink);
  font-family: var(--font-num);
}

.hint {
  font-size: 11.5px;
  color: var(--ink-4);
}
</style>
