<script setup>
import { computed, onMounted } from 'vue'
import { useBillStore } from '@/stores/bill.js'
import { useCategoryStore } from '@/stores/category.js'
import AppHeader from '@/components/AppHeader.vue'
import IconBase from '@/components/icons/IconBase.vue'
import TabBar from '@/components/TabBar.vue'
import CategoryIcon from '@/components/CategoryIcon.vue'
import AmountText from '@/components/AmountText.vue'
import { formatMonthLabel } from '@/utils/date.js'
import { round2 } from '@/utils/money.js'

const billStore = useBillStore()
const categoryStore = useCategoryStore()

const summary = computed(() => billStore.summary)

/** 按一级分类聚合本月支出 */
const ranking = computed(() => {
  const map = new Map()
  billStore.bills
    .filter((b) => b.type === 'expense')
    .forEach((b) => {
      const key = b.primaryCategoryId || 'unknown'
      const cur = map.get(key) || { id: key, amount: 0, count: 0 }
      cur.amount = round2(cur.amount + b.amount)
      cur.count += 1
      map.set(key, cur)
    })

  const total = Array.from(map.values()).reduce((sum, item) => sum + item.amount, 0) || 1
  return Array.from(map.values())
    .map((item) => {
      const category = categoryStore.byId[item.id]
      return {
        ...item,
        name: category?.name || '未分类',
        icon: category?.icon || 'more',
        ratio: item.amount / total
      }
    })
    .sort((a, b) => b.amount - a.amount)
})

onMounted(async () => {
  await Promise.all([categoryStore.ensureLoaded(), billStore.ensureLoaded()])
})
</script>

<template>
  <div class="page stats-page">
    <AppHeader title="统计">
      <template #right>
        <span class="month">{{ formatMonthLabel(billStore.month) }}</span>
      </template>
    </AppHeader>

    <div class="page-body">
      <section class="hero">
        <span class="hero-label">本月支出</span>
        <div class="hero-amount">
          <AmountText :value="summary.expense" :size="32" :weight="700" space />
        </div>
        <div class="hero-foot">
          <span>日均 ¥ {{ summary.dailyAvg.toFixed(2) }}</span>
          <span>共 {{ billStore.bills.length }} 笔</span>
        </div>
      </section>

      <section class="card rank-card">
        <header class="rank-head">
          <span class="section-title">支出排行</span>
          <span class="muted">按一级分类</span>
        </header>

        <div v-for="item in ranking" :key="item.id" class="rank-row">
          <CategoryIcon :icon="item.icon" variant="mint" :size="38" />
          <div class="rank-info">
            <div class="rank-top">
              <span class="rank-name">{{ item.name }}</span>
              <span class="rank-amount">¥ {{ item.amount.toFixed(2) }}</span>
            </div>
            <div class="track">
              <i class="fill" :style="{ width: `${Math.max(item.ratio * 100, 2)}%` }" />
            </div>
            <span class="rank-meta">{{ item.count }} 笔 · {{ (item.ratio * 100).toFixed(1) }}%</span>
          </div>
        </div>

        <p v-if="!ranking.length" class="empty">本月还没有支出记录</p>
      </section>

      <p class="tip">
        <IconBase name="info" :size="14" />
        统计图表将在后续版本扩展（趋势 / 预算 / 同环比）
      </p>
    </div>

    <TabBar />
  </div>
</template>

<style scoped>
.month {
  font-size: 13.5px;
  color: var(--ink-3);
  padding-right: 6px;
}

.page-body {
  /* 底部留出标签栏高度，否则最后一屏内容会被固定的 TabBar 盖住 */
  padding: 0 14px var(--tabbar-space);
}

.hero {
  padding: 16px 18px 14px;
  border-radius: var(--r-lg);
  background: var(--brand-grad);
  color: #fff;
}

.hero-label {
  font-size: 13px;
  color: var(--on-brand-dim);
}

.hero-amount {
  margin: 8px 0 12px;
}

.hero-foot {
  display: flex;
  gap: 16px;
  font-size: 12.5px;
  color: var(--on-brand-dim);
}

.rank-card {
  margin-top: 12px;
  padding: 16px;
}

.rank-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.muted {
  font-size: 12px;
  color: var(--ink-3);
}

.rank-row {
  display: flex;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--hairline);
}

.rank-row:last-of-type {
  border-bottom: none;
}

.rank-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rank-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.rank-name {
  font-size: 14px;
}

.rank-amount {
  font-size: 14px;
  font-family: var(--font-num);
}

.track {
  height: 5px;
  border-radius: 3px;
  background: var(--surface-3);
  overflow: hidden;
}

.fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--brand);
}

.rank-meta {
  font-size: 11.5px;
  color: var(--ink-3);
}

.empty {
  margin: 30px 0;
  text-align: center;
  color: var(--ink-4);
  font-size: 13px;
}

.tip {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 16px 4px 0;
  font-size: 12px;
  color: var(--ink-3);
}
</style>
