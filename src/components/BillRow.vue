<script setup>
import CategoryIcon from './CategoryIcon.vue'
import AmountText from './AmountText.vue'

const props = defineProps({
  bill: { type: Object, required: true },
  /** 是否显示分类图标 */
  showIcon: { type: Boolean, default: true },
  size: { type: Number, default: 40 }
})

const emit = defineEmits(['click'])
</script>

<template>
  <button class="bill-row" type="button" @click="emit('click', bill)">
    <CategoryIcon
      v-if="showIcon"
      :icon="bill.categoryIcon || 'more'"
      variant="mint"
      :size="size"
      :icon-ratio="0.5"
    />
    <div class="info">
      <span class="name">{{ bill.displayName }}</span>
      <span v-if="bill.remark" class="remark">{{ bill.remark }}</span>
    </div>
    <AmountText
      class="money"
      :value="bill.amount"
      :sign="bill.type === 'income' ? '+' : '-'"
      space
      :size="16"
      :weight="500"
    />
  </button>
</template>

<style scoped>
.bill-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 0;
  text-align: left;
}

.bill-row:active {
  opacity: 0.65;
}

.info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.name {
  font-size: 14.5px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remark {
  font-size: 12px;
  color: var(--ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.money {
  flex: none;
  color: var(--ink);
}
</style>
