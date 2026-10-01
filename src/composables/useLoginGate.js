import { cloud } from '@/api'
import { useAccountStore } from '@/stores/account.js'
import { openLoginSheet } from './useLoginSheet.js'

/**
 * 写操作登录门禁（S7-5）
 * ------------------------------------------------------------
 * ## 它解决什么
 *
 * S7 去掉了匿名身份，于是「未登录」从一个**隐形的中间态**（后台偷偷开了个
 * 匿名账号，用户根本不知道）变成了一个**真实的界面状态**：没有云端身份、
 * 数据只在本机、同步不会发生。那么写操作就必须有个明确的态度 ——
 * 「记一笔」「建分类」这些动作一旦发生，用户是有理由期待它们能同步的。
 *
 * 所以：**未登录时点写操作 → 弹登录**。读操作（首页 / 账单 / 统计）不拦，
 * 未登录也能看能算（`ledger_guest` 分区里有账本和分类，只是账单为空）。
 *
 * ## 只用一处判断
 *
 * 所有写入口都调 {@link requireLogin}，判断逻辑只有这一份 —— 以后要改成
 * 「允许本地记账但提醒」或者「加游客模式」，只动这里。
 *
 * ## 门禁**不是**安全边界
 *
 * 它只是 UI 层的引导。真正的边界在云端：CloudBase 的 PRIVATE 权限按 `_openid`
 * 隔离，没登录态连数据方法的门都进不去（适配器会抛 `NOT_SIGNED_IN`）。
 * 所以不必担心「有人绕过门禁直接调 repository」—— 绕过去了也写不到云上。
 */

/**
 * 门禁判定（**纯逻辑**，无副作用，可在 Node 里直接断言）。
 *
 * 规则只有一条：**没配云端时放行**（纯本地记账，没有「登录」这个概念）。
 * 配了云端就必须有登录态。
 *
 * @param {{ hasCloud: boolean, signedIn: boolean }} ctx
 * @returns {boolean} `true` = 放行
 */
export function shouldAllowWrite({ hasCloud, signedIn } = {}) {
  return !hasCloud || Boolean(signedIn)
}

/**
 * 读当前真实的门禁上下文（需要 Pinia 已就绪 —— 守卫在 app 安装后才跑）。
 *
 * ⚠️ `signedIn` 取**两个来源的并集**，不能只看 store：
 *    `cloud.signedIn` 是云端适配器的实时状态（`main.js` 的 `initDataLayer()`
 *    一启动就读过一次身份，所以它总是准的）；而 store 里的 `uid` 要等
 *    `bootstrap()` 落地。只看 store 会出现「明明登录着，首页点 + 却被拦住」
 *    这种假拦截（实测踩到）。
 */
function liveGateContext() {
  const account = useAccountStore()
  return {
    hasCloud: Boolean(cloud),
    signedIn: cloud?.signedIn === true || account.signedIn
  }
}

/**
 * 写操作前调用。
 *
 * @param {string} label 动作名，会拼进弹层说明（如「记一笔需要先登录…」）
 * @param {Function} [after] 登录成功后接着执行的动作（可选）。
 *   典型场景：未登录点某笔账单想去编辑 → 登录完成后自动把那笔账打开。
 * @param {{hasCloud:boolean, signedIn:boolean}} [ctx] **测试注入点**：
 *   不传时自己去读 cloud 与 account store（那需要 Pinia 已就绪）。
 *   传了就完全不碰全局状态，于是门禁逻辑能在 Node 里直接断言。
 * @returns {boolean} `true` = 放行，调用方继续；`false` = 已弹登录，
 *   调用方必须**立刻中止**本次写操作（不要接着执行后面的代码）
 */
export function requireLogin(label, after = null, ctx = null) {
  if (shouldAllowWrite(ctx || liveGateContext())) return true

  openLoginSheet({
    reason: `${label}需要先登录。登录后数据会同步到云端，换设备也能找回。`,
    onSuccess: after
  })
  return false
}
