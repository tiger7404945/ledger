/**
 * 云端资源命名表（前端）
 * ------------------------------------------------------------
 * ⚠️ **这个 CloudBase 环境后续可能被其它项目复用。**
 *    所以所有云端资源的命名都以项目名 `ledger` 打头，避免与别的项目撞名。
 *    规则见 phase2-backend-plan.md 第 3 节 P0。
 *
 * 为什么单独一个文件而不是写在适配器里：
 *   集合名是「适配器私有」的（只有 cloudbaseAdapter 用），但**云函数名是跨层共享**的
 *   —— 前端要调它、云函数源码目录要用它、部署脚本也要用它。放一处，三边都从这里取，
 *   改名字时不会漏。
 */

/** 集合名前缀（与 cloudbaseAdapter.js 的 CLOUD_COLLECTION_PREFIX 必须一致） */
export const CLOUD_COLLECTION_PREFIX = 'ledger_'

/**
 * 云函数名表。
 *
 * 命名约定：`ledger<功能名>`，用连字符分词。
 *   - 云函数名有自己的限制：字母开头，只允许字母/数字/连字符/下划线。
 *   - 控制台里函数列表按名字混排，`ledger-` 前缀能让本项目的函数一眼区分出来。
 *
 * 部署方式：**本地目录名必须与云端函数名完全一致**。
 *   CloudBase MCP 的 `createFunction` 会用 `functionRootPath + '/' + 函数名` 去拼本地目录，
 *   所以 `ledger-server-time` 对应的目录也必须是 `cloudfunctions/ledger-server-time/`。
 *   （曾经用过下划线目录名，实测报「路径不存在」，改成连字符后通过。）
 */
export const CLOUD_FUNCTIONS = {
  /**
   * 服务端时间（S4-2）。
   *
   * 为什么需要它：CloudBase **Web SDK 没有「读服务端当前时间」的接口**
   * （`serverDate()` 只能把时间写进文档，不能读回来）。于是客户端只能拿到
   * 「能观察到的最新 `_serverTs`」，那是**下界**不是当前时间 ——
   * 当水位线安全，**做冲突裁决就不可靠了**（两边时钟不同步时会把旧的判成新的）。
   *
   * 所以用一个云函数返回真正的服务端当前时间。云函数运行在腾讯云侧，
   * `Date.now()` 就是服务端时钟。
   */
  SERVER_TIME: 'ledger-server-time'
}

/** 本项目所有云端资源名都必须以此开头（校验用） */
export const CLOUD_RESOURCE_PREFIX = 'ledger'

/**
 * HTTP 网关路径表。
 *
 * ⚠️ **为什么走 HTTP 网关而不是 `app.callFunction()`**（这是实测踩出来的）：
 *
 *   Web SDK 的 `app.callFunction()` 在**匿名登录态**下会返回
 *   403 `EXCEED_AUTHORITY` —— 云函数默认安全规则是
 *   `{ "*": { "invoke": "auth != null && auth.loginType != 'ANONYMOUS'" } }`，
 *   即「必须登录且非匿名」。而本项目**只用匿名登录**，天然被拒。
 *
 *   尝试过用 `managePermissions(updateResourcePermission, resourceType='function',
 *   securityRule='{"invoke":true}')` 放开，接口回 `Success: true`，但复读权限
 *   仍是原规则 —— **实际没生效**（该环境是纯 NoSQL 后端，函数权限的写入路径
 *   可能不适用）。所以不要指望改函数权限这条路。
 *
 *   可靠的做法是走 **HTTP 网关**：`manageGateway(createRoute, upstreamResourceType='SCF',
 *   auth=false)` 把函数挂在网关路径上。网关的 `EnableAuth=false` 是真实生效的，
 *   实测 `curl` 该路径返回 200 + 正确时间戳。
 *
 *   代价：多一次网关转发、端点要写全域名（下面的 CLOUD_FUNCTIONS.SERVER_TIME 仍是
 *   函数名，供部署用；HTTP 路径单独列在这里）。
 *
 * 端点形如：
 *   `https://<环境默认 HTTPSERVICE 域名>/<path>`
 * 环境默认域名由平台分配，**不写死**，从 `VITE_CLOUDBASE_API_BASE` 注入。
 */
export const CLOUD_HTTP_PATHS = {
  /** 对应云函数 SERVER_TIME，网关路径与函数名同名 */
  SERVER_TIME: '/ledger-server-time'
}
