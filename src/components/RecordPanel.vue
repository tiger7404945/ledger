<script setup>
import { computed, ref } from 'vue'
import IconBase from './icons/IconBase.vue'
import NumericKeypad from './NumericKeypad.vue'
import { formatDateCN, todayKey } from '@/utils/date.js'

const props = defineProps({
  /** 已经格式化好的金额文本，例如 "0.00" / "128.50" */
  amountText: { type: String, default: '0.00' },
  ledgerName: { type: String, default: '默认账本' }
})

const emit = defineEmits(['key', 'action'])

const remark = defineModel('remark', { type: String, default: '' })
const dateKey = defineModel('dateKey', { type: String, default: todayKey() })
const noReimburse = defineModel('noReimburse', { type: Boolean, default: false })

const dateInput = ref(null)

const dateLabel = computed(() => {
  if (dateKey.value === todayKey()) return '今天'
  return formatDateCN(dateKey.value)
})

function openDatePicker() {
  const el = dateInput.value
  if (!el) return
  if (typeof el.showPicker === 'function') el.showPicker()
  else el.click()
}

function onDateChange(e) {
  if (e.target.value) dateKey.value = e.target.value
}
</script>

<template>
  <div class="record-panel">
    <div class="top">
      <input
        v-model="remark"
        class="remark"
        type="text"
        maxlength="40"
        placeholder="点击填写备注..."
      />
      <div class="amount">
        <span class="symbol">¥</span><span class="value">{{ amountText }}</span>
      </div>
    </div>

    <div class="chips">
      <button class="chip is-on" type="button" @click="openDatePicker">
        <IconBase name="clock" :size="13" :stroke-width="1.8" />
        {{ dateLabel }}
      </button>
      <input
        ref="dateInput"
        class="date-input"
        type="date"
        :value="dateKey"
        @change="onDateChange"
      />

      <span class="chip is-on">
        <IconBase name="checkbox-on" :size="12" :stroke-width="1.4" />
        {{ ledgerName }}
      </span>

      <button class="chip" type="button" @click="emit('action', 'account')">
        <IconBase name="checkbox-off" :size="12" :stroke-width="1.4" />
        资产账户
      </button>
      <button class="chip" type="button" @click="emit('action', 'image')">
        <IconBase name="checkbox-off" :size="12" :stroke-width="1.4" />
        图片
      </button>
      <button
        class="chip"
        :class="{ 'is-on': noReimburse }"
        type="button"
        @click="noReimburse = !noReimburse"
      >
        <IconBase :name="noReimburse ? 'checkbox-on' : 'checkbox-off'" :size="12" :stroke-width="1.4" />
        不报销
      </button>
    </div>

    <NumericKeypad @key="(k) => emit('key', k)" />
  </div>
</template>

<style scoped>
.record-panel {
  flex: none;
  background: #fff;
}

.top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 18px 10px;
  border-bottom: 1px solid var(--hairline);
}

.remark {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  color: var(--ink);
}

.amount {
  display: flex;
  align-items: baseline;
  color: var(--ink);
  font-family: var(--font-num);
  line-height: 1.1;
}

.amount .symbol {
  font-size: 20px;
  font-weight: 500;
  margin-right: 1px;
}

.amount .value {
  font-size: 30px;
  font-weight: 600;
  letter-spacing: -0.5px;
}

.chips {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  overflow-x: auto;
  scrollbar-width: none;
}

.chips::-webkit-scrollbar {
  display: none;
}

.chip {
  flex: none;
  height: 26px;
  padding: 0 8px;
  font-size: 11.5px;
  gap: 3px;
}

.date-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
</style>
