import { ref } from 'vue'

/**
 * 轻量 Toast（底部提示），全局单例。
 * ToastHost.vue 负责渲染。
 */

export const toasts = ref([])
let seed = 0

export function useToast() {
  function show(message, { duration = 1800, type = 'text' } = {}) {
    seed += 1
    const id = seed
    toasts.value = [...toasts.value, { id, message, type }]
    window.setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    }, duration)
    return id
  }

  return {
    toasts,
    show,
    success: (msg, opts) => show(msg, { ...opts, type: 'success' }),
    error: (msg, opts) => show(msg, { ...opts, type: 'error' })
  }
}
