/**
 * 测试用的路径别名解析（`@/` → `src/`）
 * ------------------------------------------------------------
 * 浏览器里 `@/` 由 Vite 的 `resolve.alias` 解析（见 vite.config.js），
 * Node 里没有这个概念 —— 于是那些 `import { x } from '@/api'` 的模块
 * （store / composable）在测试脚本里**import 不了**，只能干测纯计算模块。
 *
 * 这个 loader 补上两步，让 `scripts/*.mjs` 也能 import 带别名的模块：
 *
 *   1. `@/xxx` → `<项目根>/src/xxx`（与 vite.config.js 的 alias 一致）；
 *   2. **补扩展名** —— Vite 会把 `@/api` 解析成 `src/api/index.js`，Node 不会
 *      （它直接报 `ERR_UNSUPPORTED_DIR_IMPORT`）。这里按 `.js` → `/index.js`
 *      的顺序试一遍，与 Vite 的行为对齐。
 *
 * 用法（必须放在动态 import 之前）：
 *
 *   import { register } from 'node:module'
 *   register(new URL('./_alias-loader.mjs', import.meta.url).href, import.meta.url)
 *   const { useAccountStore } = await import('@/stores/account.js')
 *
 * ⚠️ 只处理 `@/` 前缀，别的一律交给默认解析 —— 保持最小改动面。
 * ⚠️ `.vue` 仍然 import 不了（Node 不认识单文件组件），测 store / composable
 *    没问题，测组件不行。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = new URL('../src/', import.meta.url)

/** 没有扩展名的裸路径才需要补（`@/stores/account.js` 这种直接放行） */
const HAS_EXTENSION = /\.[a-z0-9]+$/i

export function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('@/')) return nextResolve(specifier, context)

  const target = new URL(specifier.slice(2), SRC)

  if (!HAS_EXTENSION.test(target.pathname)) {
    for (const candidate of [`${target.href}.js`, `${target.href}/index.js`]) {
      try {
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate, context)
      } catch (e) {
        /* 这个候选不成立，继续试下一个 */
      }
    }
  }

  return nextResolve(target.href, context)
}
