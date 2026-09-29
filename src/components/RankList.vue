<script setup>
/**
 * 分类排行（统计页）
 * 默认只显示金额最大的 3 项，超过 3 项时给出「查看更多 / 收起」。
 */
import { computed, ref } from 'vue'
import IconBase from './icons/IconBase.vue'
import CategoryIcon from './CategoryIcon.vue'

const props = defineProps({
  /** [{ id, name, icon, amount, count, ratio }]，已按金额降序 */
  items: { type: Array, default: () => [] },
  /** 标题，如「支出排行」 */
  title: { type: String, default: '' },
  emptyText: { type: String, default: '当期还没有记录' }
})

const COLLAPSED = 3

const expanded = ref(false)
const canExpand = computed(() => props.items.length > COLLAPSED)
const visible = computed(() => (expanded.value ? props.items : props.items.slice(0, COLLAPSED)))
</script>

<template>
  <section class="card rank-card">
    <header class="rank-head">
      <span class="section-title">{{ title }}</span>
      <span class="muted">按一级分类</span>
    </header>

    <div v-for="item in visible" :key="item.id" class="rank-row">
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

    <p v-if="!items.length" class="empty">{{ emptyText }}</p>

    <button v-if="canExpand" class="more" type="button" @click="expanded = !expanded">
      {{ expanded ? '收起' : '查看更多' }}
      <IconBase :name="expanded ? 'chevronUp' : 'chevronDown'" :size="15" :stroke-width="2" />
    </button>
  </section>
</template>

<style scoped>
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

.more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  width: 100%;
  height: 34px;
  margin-top: 12px;
  border-radius: var(--r-pill);
  background: var(--surface-2);
  color: var(--ink-2);
  font-size: 13px;
}

.more:active {
  background: var(--surface-3);
}
</style>
