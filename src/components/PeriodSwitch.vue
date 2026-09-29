<script setup>
/**
 * 账期切换器 —— 账单页与统计页共用的同一个模组
 *
 * 结构：白色药丸 + 左右两个薄荷圆箭头 + 中间可点的日期文字；点日期打开
 * PeriodPicker 弹层（按月 / 按年）。两页都只写 <PeriodSwitch /> 一行。
 *
 * 账期状态直接读写 billStore 的 period 切片：两页共用同一份「当期」，
 * 在任一处切换，另一处保持一致。
 *
 * 几何对齐设计稿「微信图片_20260927231957_12_4.jpg」顶部筛选行（1080x2400 采样）：
 * 药丸高 31、全圆角；圆钮 21、四周内缩 5；圆底 #DCFDF6（--brand-mint）、
 * 箭头主题绿；日期 13.5px 深色。设计稿药丸宽 171.5，这里收到 154 ——
 * 统计页的页头右侧要塞得下而不压到居中标题，两页仍保持完全一致。
 */
import { computed, ref } from 'vue'
import { useBillStore } from '@/stores/bill.js'
import IconBase from './icons/IconBase.vue'
import PeriodPicker from './PeriodPicker.vue'

const billStore = useBillStore()
const pickerOpen = ref(false)

/** 按年模式下箭头翻年，按月模式翻月 */
const isYear = computed(() => billStore.period.mode === 'year')

function onPickMonth(month) {
  billStore.setPeriodMonth(month)
}

function onPickYear(year) {
  billStore.setPeriodYear(year)
}
</script>

<template>
  <div class="period-switch">
    <button
      class="arrow"
      type="button"
      :aria-label="isYear ? '上一年' : '上个月'"
      @click="billStore.shiftPeriod(-1)"
    >
      <IconBase name="chevronLeft" :size="15" :stroke-width="2.4" />
    </button>

    <button class="label" type="button" aria-label="选择月份或年份" @click="pickerOpen = true">
      {{ billStore.periodLabel }}
    </button>

    <button
      class="arrow"
      type="button"
      :aria-label="isYear ? '下一年' : '下个月'"
      @click="billStore.shiftPeriod(1)"
    >
      <IconBase name="chevronRight" :size="15" :stroke-width="2.4" />
    </button>

    <PeriodPicker
      v-model="pickerOpen"
      :mode="billStore.period.mode"
      :month="billStore.period.month"
      :year="billStore.period.year"
      @pick-month="onPickMonth"
      @pick-year="onPickYear"
    />
  </div>
</template>

<style scoped>
.period-switch {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 5px;
  border-radius: var(--r-pill);
  background: var(--surface);
}

.arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 21px;
  height: 21px;
  border-radius: 50%;
  background: var(--brand-mint);
  color: var(--brand);
}

.arrow:active {
  background: var(--brand-soft-2);
}

/* 固定宽度：月份（2026年12月）与年份（2026年）标签长度不同，
   不固定的话切模式时药丸宽度会跳。 */
.label {
  min-width: 78px;
  padding: 0 2px;
  font-size: 13.5px;
  line-height: 17px;
  text-align: center;
  color: var(--ink);
  border-radius: var(--r-sm);
}

.label:active {
  background: var(--surface-3);
}
</style>
