import { reactive } from 'vue'

/**
 * 全局登录弹层的状态（S7-4）
 * ------------------------------------------------------------
 * **模块级单例** —— 这是关键。登录弹层不再属于「我的」页，而是被三处共用：
 *
 *   1. 「我的」页的登录按钮；
 *   2. 写操作门禁（`useLoginGate`）：未登录去记一笔 → 弹登录；
 *   3. 路由守卫：未登录直接进 `/record` 或 `/category*` → 弹登录。
 *
 * 三者共享同一份状态，才能做到「**登录成功后接着把原来那件事做完**」：
 * 门禁把动作登记在 `pending` 里，弹层登录成功后调 {@link resolveLoginSheet}
 * 执行它。如果状态是每个组件各自 `ref` 一份，登录完就没人知道要干什么了。
 *
 * 为什么不做成 Pinia store：登录弹层是**纯 UI 状态**，不需要持久化、不需要
 * 跨设备，也没必要进 devtools 的时间旅行。一个 reactive 对象够了，
 * 而且能在组件外（路由守卫）直接调用。
 */

const state = reactive({
  /** 弹层是否可见 */
  open: false,
  /** 为什么要登录（门禁带过来的一句话，显示在弹层里解释来意） */
  reason: '',
  /**
   * 登录成功后要接着执行的动作。
   * `null` = 没有（用户主动点的登录按钮）。
   */
  pending: null
})

/**
 * 打开登录弹层。
 *
 * @param {object} [options]
 * @param {string} [options.reason] 给用户看的来意说明
 * @param {Function} [options.onSuccess] 登录成功后执行（可 async）
 */
export function openLoginSheet({ reason = '', onSuccess = null } = {}) {
  state.reason = reason
  state.pending = typeof onSuccess === 'function' ? onSuccess : null
  state.open = true
}

/** 关闭登录弹层（用户取消 / 点遮罩）。**不执行**挂起的动作 */
export function closeLoginSheet() {
  state.open = false
  state.reason = ''
  state.pending = null
}

/**
 * 登录成功：关掉弹层并执行挂起的动作。
 *
 * ⚠️ 先清状态再执行：动作里可能又触发一次门禁（比如跳到一个也需要登录的
 *    路由），如果 `pending` 还挂着，就会自己调自己。清干净再跑，语义是
 *    「弹层这一轮结束了」。
 */
export async function resolveLoginSheet() {
  const action = state.pending
  state.open = false
  state.reason = ''
  state.pending = null
  if (typeof action === 'function') await action()
}

/** 组件里用的入口（也可以直接 import 上面三个函数） */
export function useLoginSheet() {
  return {
    state,
    open: openLoginSheet,
    close: closeLoginSheet,
    resolve: resolveLoginSheet
  }
}
