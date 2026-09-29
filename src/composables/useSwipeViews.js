import { computed, ref, unref } from 'vue'

/**
 * 左右滑动切换视图（横向轨道）
 *
 * 结构：轨道宽度 = 视图数 × 100%，每屏 flex-basis = 100/视图数 %，
 * 位移 = -(当前下标 × 100/视图数)% + 拖动偏移。松手后按阈值吸附到相邻视图。
 *
 * 两条约定（账单页 / 统计页共用同一套行为）：
 * 1. **先判主方向**：纵向为主的滑动直接放弃接管（`active = false`），把滚动交还给页面，
 *    否则会跟纵向滚动打架。全程不调 preventDefault，滚动区在轨道内部照常工作。
 * 2. `ignoreSelector` 命中的区域不参与切换——统计页的折线图要独占横向手势做数据游标。
 *
 * @param {object} options
 * @param {string[]} options.views 视图 key，顺序即轨道顺序
 * @param {import('vue').Ref<string>} options.current 当前视图 key
 * @param {number} [options.threshold] 吸附阈值（px）
 * @param {string} [options.ignoreSelector] 命中该选择器的起点不触发切换
 */
export function useSwipeViews(options) {
  const views = options.views
  const current = options.current
  const threshold = options.threshold == null ? 56 : options.threshold
  const ignoreSelector = options.ignoreSelector == null ? '[data-no-swipe]' : options.ignoreSelector

  const count = views.length
  const step = 100 / count

  const drag = ref({ dx: 0, active: false })

  let startX = 0
  let startY = 0
  /** '' 未定 | 'x' 横向（切换视图） | 'y' 纵向（交给滚动） */
  let axis = ''

  const indexOf = () => {
    const i = views.indexOf(unref(current))
    return i < 0 ? 0 : i
  }

  const trackStyle = computed(() => ({
    width: `${count * 100}%`,
    transform: `translateX(calc(${-indexOf() * step}% + ${drag.value.dx}px))`
  }))

  const paneStyle = { flex: `0 0 ${step}%` }

  function onTouchStart(e) {
    if (e.touches.length !== 1) return
    const target = e.target
    if (ignoreSelector && target && target.closest && target.closest(ignoreSelector)) return
    startX = e.touches[0].clientX
    startY = e.touches[0].clientY
    axis = ''
    drag.value = { dx: 0, active: true }
  }

  function onTouchMove(e) {
    if (!drag.value.active || e.touches.length !== 1) return
    const mx = e.touches[0].clientX - startX
    const my = e.touches[0].clientY - startY

    if (!axis) {
      if (Math.abs(mx) < 6 && Math.abs(my) < 6) return
      axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y'
      if (axis === 'y') {
        drag.value = { dx: 0, active: false }
        return
      }
    }

    const i = indexOf()
    // 已经在首/末屏还继续往外拖时加阻尼
    const atEdge = (i === 0 && mx > 0) || (i === count - 1 && mx < 0)
    const paneWidth =
      e.currentTarget && e.currentTarget.clientWidth ? e.currentTarget.clientWidth / count : 320
    const d = atEdge ? mx * 0.35 : mx
    drag.value = { dx: Math.max(-paneWidth, Math.min(paneWidth, d)), active: true }
  }

  function onTouchEnd() {
    if (!drag.value.active) return
    const dx = drag.value.dx
    drag.value = { dx: 0, active: false }
    if (Math.abs(dx) < threshold) return
    const next = indexOf() + (dx < 0 ? 1 : -1)
    if (next >= 0 && next < count) current.value = views[next]
  }

  /** 供胶囊按钮调用 */
  function goTo(view) {
    if (views.includes(view)) current.value = view
  }

  return { drag, trackStyle, paneStyle, onTouchStart, onTouchMove, onTouchEnd, goTo }
}
