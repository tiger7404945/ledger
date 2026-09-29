<script setup>
/**
 * 账期选择器（账单页点顶部日期弹出）
 *
 * 「按月查看」选月份 → 筛选某个月的流水/日历
 * 「按年查看」选年份 → 筛选整年的流水/日历
 *
 * 几何与配色对齐设计稿「月选择器.jpg / 年选择器.jpg」（1080x2400 采样）：
 * 4 列网格、行距 20、单元格高 45、左右内缩 20、列间距 7、
 * 选中态为主题绿实底 + 深色文字，未来年份置灰不可选。
 */
import { computed, ref, watch } from 'vue'
import BottomSheet from './BottomSheet.vue'
import IconBase from './icons/IconBase.vue'
import { pad2 } from '@/utils/date.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** 当前筛选模式 */
  mode: { type: String, default: 'month' },
  /** 当前选中的月份，'YYYY-MM' */
  month: { type: String, required: true },
  /** 当前选中的年份 */
  year: { type: Number, required: true }
})

const emit = defineEmits(['update:modelValue', 'pick-month', 'pick-year'])

/** 年份网格一屏 12 个；当前年份前面留 8 年（2026 -> 2018..2029，与设计稿一致） */
const YEAR_WINDOW = 12
const LEADING_YEARS = 8
const CURRENT_YEAR = new Date().getFullYear()

const tab = ref(props.mode)
const cursor = ref(props.year)

// 每次打开都从当前筛选状态开始，避免上次浏览的位置残留
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    tab.value = props.mode
    cursor.value = props.year
  }
)

const windowStart = computed(() => cursor.value - LEADING_YEARS)
const years = computed(() =>
  Array.from({ length: YEAR_WINDOW }, (_, i) => windowStart.value + i)
)
/** 再往后翻一屏已经全是未来年份，没有可选项，禁用 › */
const canPageForward = computed(() => windowStart.value + YEAR_WINDOW <= CURRENT_YEAR)
const months = Array.from({ length: 12 }, (_, i) => i + 1)

function page(delta) {
  cursor.value += tab.value === 'year' ? YEAR_WINDOW * delta : delta
}

function isSelectedMonth(m) {
  return props.month === `${cursor.value}-${pad2(m)}`
}

function pickMonth(m) {
  emit('pick-month', `${cursor.value}-${pad2(m)}`)
  close()
}

function pickYear(y) {
  emit('pick-year', y)
  close()
}

function close() {
  emit('update:modelValue', false)
}
</script>

<template>
  <BottomSheet :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)">
    <div class="picker">
      <div class="tabs">
        <button
          class="tab"
          :class="{ 'is-active': tab === 'month' }"
          type="button"
          @click="tab = 'month'"
        >
          按月查看
        </button>
        <button
          class="tab"
          :class="{ 'is-active': tab === 'year' }"
          type="button"
          @click="tab = 'year'"
        >
          按年查看
        </button>
      </div>

      <div class="head">
        <button class="arrow" type="button" aria-label="上一页" @click="page(-1)">
          <IconBase name="chevronLeft" :size="20" :stroke-width="2" />
        </button>
        <span class="cur">{{ tab === 'month' ? cursor : '年份' }}</span>
        <button
          class="arrow"
          type="button"
          aria-label="下一页"
          :disabled="tab === 'year' && !canPageForward"
          @click="page(1)"
        >
          <IconBase name="chevronRight" :size="20" :stroke-width="2" />
        </button>
      </div>

      <div v-if="tab === 'month'" class="grid">
        <button
          v-for="m in months"
          :key="m"
          class="cell"
          :class="{ 'is-active': isSelectedMonth(m) }"
          type="button"
          @click="pickMonth(m)"
        >
          {{ m }}月
        </button>
      </div>

      <div v-else class="grid">
        <button
          v-for="y in years"
          :key="y"
          class="cell"
          :class="{ 'is-active': y === year }"
          type="button"
          :disabled="y > CURRENT_YEAR"
          @click="pickYear(y)"
        >
          {{ y }}
        </button>
      </div>
    </div>
  </BottomSheet>
</template>

<style scoped>
.picker {
  width: 100%;
  padding: 22px 0 calc(10px + var(--safe-b));
  background: var(--surface);
}

/* ---------- 按月查看 / 按年查看 ---------- */
.tabs {
  display: flex;
  justify-content: center;
  gap: 50px;
}

.tab {
  position: relative;
  padding-bottom: 7px;
  font-size: 15px;
  line-height: 16px;
  color: var(--ink-3);
}

.tab.is-active {
  color: var(--ink);
  font-weight: 500;
}

.tab.is-active::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 0;
  transform: translateX(-50%);
  width: 100%;
  height: 2.5px;
  border-radius: 2px;
  background: var(--brand);
}

/* ---------- ‹ 2026 / 年份 › ---------- */
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 66px;
  padding: 0 16px;
}

.cur {
  font-size: 20px;
  font-weight: 600;
  color: var(--ink);
}

.arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  color: var(--ink);
}

.arrow:active {
  background: rgba(0, 0, 0, 0.05);
}

.arrow:disabled {
  color: var(--ink-4);
}

/* ---------- 4 x 3 网格 ---------- */
.grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  column-gap: 7px;
  row-gap: 20px;
  padding: 0 20px;
}

.cell {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 45px;
  border-radius: 12px;
  font-size: 15.5px;
  color: var(--ink);
  transition: background 0.15s ease;
}

.cell.is-active {
  background: var(--brand);
  font-weight: 500;
}

.cell:disabled {
  color: var(--ink-4);
}
</style>
