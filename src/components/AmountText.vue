<script setup>
import { computed } from 'vue'
import { formatMoney } from '@/utils/money.js'

const props = defineProps({
  value: { type: [Number, String], default: 0 },
  /** '' | '-' | '+' */
  sign: { type: String, default: '' },
  symbol: { type: String, default: '¥' },
  /** 大号字体尺寸 */
  size: { type: Number, default: 20 },
  weight: { type: [Number, String], default: 500 },
  color: { type: String, default: 'inherit' },
  space: { type: Boolean, default: false },
  /** 传入原始字符串（记账面板输入中）时直接使用，不做千分位格式化 */
  raw: { type: String, default: '' }
})

const text = computed(() => (props.raw !== '' ? props.raw : formatMoney(props.value)))
</script>

<template>
  <span
    class="amount"
    :style="{ fontSize: size + 'px', fontWeight: weight, color }"
  >
    <em v-if="sign === '-'">-</em>
    <em v-else-if="sign === '+'">+</em>
    <i class="symbol">{{ symbol }}</i>
    <span :class="{ gap: space }" class="num">{{ text }}</span>
  </span>
</template>

<style scoped>
.amount {
  display: inline-flex;
  align-items: baseline;
  font-family: var(--font-num);
  line-height: 1.1;
  white-space: nowrap;
}

.amount em {
  font-style: normal;
  margin-right: 2px;
}

.symbol {
  font-style: normal;
  font-size: 0.6em;
  margin-right: 2px;
  font-weight: 500;
}

.gap {
  margin-left: 4px;
}
</style>
