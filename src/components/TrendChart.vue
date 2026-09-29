<script setup>
/**
 * 趋势折线图（统计页）
 *
 * - 按月账期：一天一个点；按年账期：一个月一个点（横轴由 points 给出）
 * - 交互：在图上滑动或点按都会把游标吸附到最近的点，浮层显示该点的日期与金额
 * - 纵向为主的滑动会放弃游标，把手势还给页面滚动；区域标了 data-no-swipe，
 *   父级的左右滑动切换不会在图表上误触发
 * - 配色沿用账单行的语义：支出深色、收入主题绿
 */
import { computed, ref, watch } from 'vue'
import { formatMoney } from '@/utils/money.js'

const props = defineProps({
  /** [{ key, axis, full, value }] */
  points: { type: Array, default: () => [] },
  /** 'expense' | 'income' */
  tone: { type: String, default: 'expense' },
  emptyText: { type: String, default: '当期还没有数据' }
})

/* 画布按 330 宽设计（390 视口下卡片内宽约 334，接近 1:1） */
const W = 330
const H = 168
const PAD = { l: 34, r: 8, t: 30, b: 22 }
const PLOT_W = W - PAD.l - PAD.r
const PLOT_H = H - PAD.t - PAD.b

const plot = ref(null)
const active = ref(-1)
const gid = `trend-${Math.random().toString(36).slice(2, 8)}`

let dragging = false
let startX = 0
let startY = 0
/** '' 未定 | 'x' 横向（移动游标） | 'y' 纵向（交还滚动） */
let axis = ''

const n = computed(() => props.points.length)
const maxValue = computed(() => props.points.reduce((m, p) => Math.max(m, p.value || 0), 0))
const hasData = computed(() => n.value > 0 && maxValue.value > 0)

/** 纵轴上限取整到好读的刻度 */
const scaleMax = computed(() => {
  const v = maxValue.value
  if (!v) return 1
  if (v >= 1000) return Math.ceil(v / 100) * 100
  if (v >= 100) return Math.ceil(v / 10) * 10
  return Math.ceil(v)
})

function xAt(i) {
  if (n.value <= 1) return PAD.l + PLOT_W / 2
  return PAD.l + (PLOT_W * i) / (n.value - 1)
}

function yAt(value) {
  const ratio = scaleMax.value ? (value || 0) / scaleMax.value : 0
  return PAD.t + PLOT_H * (1 - Math.min(1, ratio))
}

const linePath = computed(() =>
  props.points
    .map((p, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)} ${yAt(p.value).toFixed(1)}`)
    .join(' ')
)

const areaPath = computed(() => {
  if (!n.value) return ''
  const base = PAD.t + PLOT_H
  return `${linePath.value} L${xAt(n.value - 1).toFixed(1)} ${base} L${xAt(0).toFixed(1)} ${base} Z`
})

/** 两条参考线：上限与中值 */
const gridlines = computed(() => [
  { y: yAt(scaleMax.value), label: compact(scaleMax.value) },
  { y: yAt(scaleMax.value / 2), label: compact(scaleMax.value / 2) }
])

/** 横轴最多 6 个标签，避免挤在一起 */
const axisLabels = computed(() => {
  const step = Math.max(1, Math.ceil(n.value / 6))
  return props.points.map((p, i) => ({ ...p, i })).filter((p) => p.i % step === 0)
})

const activePoint = computed(() => (active.value >= 0 ? props.points[active.value] : null))
const tipLeft = computed(() => `${((xAt(active.value) / W) * 100).toFixed(2)}%`)

function compact(v) {
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万`
  return String(Math.round(v))
}

/** 距离触点最近的点 */
function indexFrom(clientX) {
  const el = plot.value
  if (!el || !n.value) return -1
  const rect = el.getBoundingClientRect()
  if (!rect.width) return -1
  const x = ((clientX - rect.left) / rect.width) * W
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < n.value; i += 1) {
    const d = Math.abs(xAt(i) - x)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

function onTouchStart(e) {
  if (e.touches.length !== 1 || !hasData.value) return
  const t = e.touches[0]
  startX = t.clientX
  startY = t.clientY
  axis = ''
  dragging = true
  active.value = indexFrom(t.clientX)
}

function onTouchMove(e) {
  if (!dragging || e.touches.length !== 1) return
  const t = e.touches[0]
  const mx = t.clientX - startX
  const my = t.clientY - startY
  if (!axis) {
    if (Math.abs(mx) < 6 && Math.abs(my) < 6) return
    axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y'
    if (axis === 'y') {
      // 纵向为主：不抢滚动，游标也一并收起
      dragging = false
      active.value = -1
      return
    }
  }
  active.value = indexFrom(t.clientX)
}

function onTouchEnd() {
  dragging = false
}

function onMouseDown(e) {
  if (!hasData.value) return
  dragging = true
  active.value = indexFrom(e.clientX)
}

function onMouseMove(e) {
  if (dragging) active.value = indexFrom(e.clientX)
}

function onMouseUp() {
  dragging = false
}

function onClick(e) {
  if (!hasData.value) return
  active.value = indexFrom(e.clientX)
}

// 账期或视图切换后，旧的游标位置已经没意义
watch(
  () => props.points,
  () => {
    active.value = -1
  }
)
</script>

<template>
  <div class="trend">
    <div
      v-if="hasData"
      ref="plot"
      class="plot"
      data-no-swipe
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
      @touchend="onTouchEnd"
      @touchcancel="onTouchEnd"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="onMouseUp"
      @mouseleave="onMouseUp"
      @click="onClick"
    >
      <svg class="chart" :class="`is-${tone}`" :viewBox="`0 0 ${W} ${H}`">
        <defs>
          <linearGradient :id="gid" x1="0" y1="0" x2="0" y2="1">
            <stop class="stop-top" offset="0%" />
            <stop class="stop-bottom" offset="100%" />
          </linearGradient>
        </defs>

        <g class="grid">
          <template v-for="g in gridlines" :key="g.label">
            <line class="grid-line" :x1="PAD.l" :x2="W - PAD.r" :y1="g.y" :y2="g.y" />
            <text class="ylab" :x="PAD.l - 6" :y="g.y + 3">{{ g.label }}</text>
          </template>
        </g>

        <path class="area" :d="areaPath" :fill="`url(#${gid})`" />
        <path class="line" :d="linePath" />

        <template v-if="activePoint">
          <line
            class="guide"
            :x1="xAt(active)"
            :x2="xAt(active)"
            :y1="PAD.t - 6"
            :y2="PAD.t + PLOT_H"
          />
          <circle class="dot" :cx="xAt(active)" :cy="yAt(activePoint.value)" r="3.6" />
        </template>

        <text
          v-for="p in axisLabels"
          :key="p.key"
          class="xlab"
          :x="xAt(p.i)"
          :y="H - 6"
          :text-anchor="p.i === 0 ? 'start' : 'middle'"
        >
          {{ p.axis }}
        </text>
      </svg>

      <div v-if="activePoint" class="tip" :style="{ '--x': tipLeft }">
        <b>{{ activePoint.full }}</b>
        <span>¥ {{ formatMoney(activePoint.value) }}</span>
      </div>
    </div>

    <p v-else class="empty">{{ emptyText }}</p>
  </div>
</template>

<style scoped>
.plot {
  position: relative;
}

.chart {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

/* ---------- 网格与坐标 ---------- */
.grid-line {
  stroke: var(--surface-4);
  stroke-width: 1;
}

.ylab {
  fill: var(--ink-4);
  font-size: 9px;
  font-family: var(--font-num);
  text-anchor: end;
}

.xlab {
  fill: var(--ink-4);
  font-size: 9.5px;
}

/* ---------- 折线与填充 ---------- */
.line {
  fill: none;
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.guide {
  stroke: var(--ink-4);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}

.dot {
  fill: var(--surface);
  stroke-width: 2.4;
}

/* 支出：深色（与账单行「支」一致）；收入：主题绿 */
.chart.is-expense .line {
  stroke: var(--ink);
}
.chart.is-expense .dot {
  stroke: var(--ink);
}
.chart.is-expense .stop-top {
  stop-color: var(--ink);
  stop-opacity: 0.18;
}
.chart.is-expense .stop-bottom {
  stop-color: var(--ink);
  stop-opacity: 0;
}

.chart.is-income .line {
  stroke: var(--brand);
}
.chart.is-income .dot {
  stroke: var(--brand);
}
.chart.is-income .stop-top {
  stop-color: var(--brand);
  stop-opacity: 0.3;
}
.chart.is-income .stop-bottom {
  stop-color: var(--brand);
  stop-opacity: 0;
}

/* ---------- 游标浮层 ---------- */
.tip {
  position: absolute;
  top: 0;
  left: clamp(62px, var(--x), calc(100% - 62px));
  transform: translateX(-50%);
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 8px;
  border-radius: var(--r-pill);
  background: rgba(16, 18, 22, 0.86);
  color: #fff;
  font-size: 11px;
  white-space: nowrap;
  pointer-events: none;
}

.tip b {
  font-weight: 500;
}

.tip span {
  font-family: var(--font-num);
}

.empty {
  margin: 0;
  padding: 46px 0;
  text-align: center;
  font-size: 13px;
  color: var(--ink-4);
}
</style>
