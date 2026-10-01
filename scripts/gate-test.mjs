/**
 * 写操作登录门禁的断言（S7-5，新增脚本）
 * 运行：node scripts/gate-test.mjs
 *
 * 覆盖三件事：
 * 1. **路由表**：哪些入口需要登录。用**源码扫描**而不是 import —— 路由表里
 *    挂着 `.vue` 组件，Node 认不了单文件组件。扫描能防住「手滑删掉
 *    `meta.requiresAuth`」这种最危险的改动（删了不报错，只是门禁静默失效）。
 * 2. **判定真值表**：`shouldAllowWrite` 的三种输入组合。
 * 3. **弹层状态机**：打开 / 关闭 / 登录成功后执行挂起的动作（门禁的核心
 *    价值就是「登录完接着把原来那件事做完」）。
 */
import { readFileSync } from 'node:fs'
import { register } from 'node:module'

import { createSuite } from './_harness.mjs'

// 让 Node 也能解析 `@/`（见 _alias-loader.mjs 的说明）。必须在使用之前注册。
register(new URL('./_alias-loader.mjs', import.meta.url).href, import.meta.url)

const t = createSuite('gate-test')

/* ---------------- 1. 路由表：哪些入口需要登录 ---------------- */

{
  const routerSrc = readFileSync(new URL('../src/router/index.js', import.meta.url), 'utf8')

  /**
   * 取某个 path 到**下一个** `path:` 之间的片段，在这段里找 requiresAuth。
   * ⚠️ 不能简单截 320 个字符：`/`（首页）后面紧跟着 `/bills`、`/record`，
   *    窗口一大就会把别人的 meta 算到自己头上（实测误报）。
   */
  const metaHasAuth = (path) => {
    const key = `path: '${path}'`
    const at = routerSrc.indexOf(key)
    if (at < 0) return null // null = 路由都没找到，与「没设 meta」要分开报
    const rest = routerSrc.slice(at + key.length)
    const next = rest.indexOf('path:')
    const seg = next < 0 ? rest : rest.slice(0, next)
    return /requiresAuth:\s*true/.test(seg)
  }

  t.ok('1a 记一笔（/record）需要登录', metaHasAuth('/record') === true)
  t.ok('1b 分类管理（/category）需要登录', metaHasAuth('/category') === true)
  t.ok('1c 分类编辑（/category/edit）需要登录', metaHasAuth('/category/edit') === true)

  // 读操作的三个 Tab 与「我的」不该被拦：未登录也要能看能算
  t.ok('1d 首页不拦', metaHasAuth('/') === false)
  t.ok('1e 账单页不拦', metaHasAuth('/bills') === false)
  t.ok('1f 统计页不拦', metaHasAuth('/stats') === false)
  t.ok('1g 我的页不拦', metaHasAuth('/mine') === false)

  // 守卫必须注册在草稿守卫之前：否则被拦下的导航会被草稿守卫当成「离开记账页」
  const guardAt = routerSrc.indexOf('router.beforeEach')
  const draftAt = routerSrc.indexOf('installRecordDraftGuard(router)')
  t.ok(
    '1h 门禁守卫注册在草稿守卫之前',
    guardAt >= 0 && draftAt >= 0 && guardAt < draftAt,
    `guards at ${guardAt} / draft at ${draftAt}`
  )

  // 未登录被拦下时，登录成功后要把这次导航接着做完
  t.ok('1i 被拦下的导航会登记「登录后继续」', /onSuccess|after/.test(routerSrc.slice(guardAt, guardAt + 500)))
}

/* ---------------- 2. 判定真值表 ---------------- */

const { shouldAllowWrite, requireLogin } = await import('@/composables/useLoginGate.js')
const sheetMod = await import('@/composables/useLoginSheet.js')
const sheet = sheetMod.useLoginSheet()

{
  t.ok(
    '2a 没配云端：放行（纯本地记账，没有登录这个概念）',
    shouldAllowWrite({ hasCloud: false, signedIn: false }) === true
  )
  t.ok('2b 配了云端 + 已登录：放行', shouldAllowWrite({ hasCloud: true, signedIn: true }) === true)
  t.ok('2c 配了云端 + 未登录：不放行', shouldAllowWrite({ hasCloud: true, signedIn: false }) === false)

  // 传空对象也不能抛（守卫早期可能拿不到完整上下文）
  t.ok('2d 空上下文默认放行', shouldAllowWrite() === true)

  /* requireLogin 的三态。第三个参数是**显式上下文**（给测试用的注入点），
     不传才去读真实的 cloud / account store。 */
  sheet.close()
  t.ok('2e 未登录：拦下本次写操作', requireLogin('记账', null, { hasCloud: true, signedIn: false }) === false)
  t.ok('2f 未登录：弹层被打开', sheet.state.open === true)
  t.ok('2g 未登录：说明里带上了动作名', sheet.state.reason.includes('记账'))

  sheet.close()
  t.ok('2h 已登录：放行且不弹层', requireLogin('记账', null, { hasCloud: true, signedIn: true }) === true && sheet.state.open === false)
  t.ok('2i 无云端：放行且不弹层', requireLogin('记账', null, { hasCloud: false, signedIn: false }) === true && sheet.state.open === false)
  sheet.close()
}

/* ---------------- 3. 弹层状态机与挂起动作 ---------------- */

{
  t.ok('3a 初始是关闭的', sheet.state.open === false)

  let ran = 0
  sheetMod.openLoginSheet({ reason: '为了记一笔', onSuccess: () => { ran += 1 } })
  t.ok('3b open 后可见且记下来意', sheet.state.open === true && sheet.state.reason === '为了记一笔')
  t.ok('3c 挂起的动作还没执行（要等登录成功）', ran === 0)

  sheetMod.closeLoginSheet()
  t.ok('3d 用户取消：弹层关闭、动作被丢弃', sheet.state.open === false && sheet.state.pending === null)

  await sheetMod.resolveLoginSheet()
  t.ok('3e 取消后 resolve 不会执行被丢弃的动作', ran === 0)

  // 正常路径
  sheetMod.openLoginSheet({ reason: '为了记一笔', onSuccess: () => { ran += 1 } })
  await sheetMod.resolveLoginSheet()
  t.ok('3f 登录成功：执行挂起的动作', ran === 1)
  t.ok('3g 登录成功：弹层关闭、状态清空', sheet.state.open === false && sheet.state.pending === null && sheet.state.reason === '')

  // 动作本身失败不该让弹层停在「开」的状态（先清状态再执行）
  sheetMod.openLoginSheet({ reason: 'x', onSuccess: () => { throw new Error('boom') } })
  let threw = false
  try {
    await sheetMod.resolveLoginSheet()
  } catch (e) {
    threw = true
  }
  t.ok('3h 挂起动作抛错：异常照常抛出（调用方能看到）', threw === true)
  t.ok('3i 挂起动作抛错：弹层已提前关闭、不会被卡住', sheet.state.open === false)

  // 登录动作里又触发门禁时，不能自己调自己
  sheetMod.openLoginSheet({ reason: 'x', onSuccess: () => {
    t.ok('3j 执行挂起动作时 pending 已清空（防递归）', sheet.state.pending === null && sheet.state.open === false)
  } })
  await sheetMod.resolveLoginSheet()

  // 没有挂起动作时（用户自己点登录按钮）也要能安全收尾
  sheetMod.openLoginSheet({ reason: '手动登录' })
  await sheetMod.resolveLoginSheet()
  t.ok('3k 无挂起动作时 resolve 安全返回', sheet.state.open === false)
}

t.done()
