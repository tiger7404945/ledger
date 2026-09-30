/**
 * 云函数：ledger-server-time —— 返回真正的服务端当前时间（S4-2）
 * ------------------------------------------------------------
 * 解决的问题
 *   本地「新者胜」（LWW）依赖**客户端时钟**裁决谁更新。手机时钟可能不准，
 *   慢的那台永远输，于是新数据会被旧数据覆盖。
 *
 *   而 CloudBase 的 Web SDK **没有**「读服务端当前时间」的接口：
 *   `db.serverDate()` 只能把时间写进文档，读回来的是那条文档的写入时间。
 *   所以客户端只能拿到「能观察到的最新 `_serverTs`」，那是**下界**，
 *   做水位线安全，**做冲突裁决不可靠**。
 *
 *   这个云函数跑在腾讯云侧，`Date.now()` 就是服务端时钟 —— 返回它即可。
 *
 * 返回结构（客户端约定，不要改字段名）
 *   { ok: true, serverTime: <毫秒时间戳>, iso: <ISO 字符串>, env: <envId> }
 *
 * 权限
 *   只读、无参、不碰数据库。任何人调用都只会得到一个时间戳，没有信息泄露。
 *   —— 所以**刻意不做额外鉴权**。它拿不到调用者的 openid 也不需要。
 *
 * 命名
 *   云端函数名 `ledger-server-time`，带项目前缀（环境可能多项目复用）。
 *   本地目录名**必须与函数名完全一致**（`cloudfunctions/ledger-server-time/`）——
 *   MCP 的 createFunction 用 `functionRootPath + '/' + 函数名` 拼本地路径，
 *   不一致会直接报「路径不存在」。
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

/**
 * @param {object} event 调用参数（本函数不使用）
 * @param {object} context 调用上下文
 * @returns {{ok: boolean, serverTime: number, iso: string, env: string}}
 */
exports.main = async (event, context) => {
  const now = Date.now()
  // 优先用环境变量里的 envId（部署时会注入）；拿不到就退回 DYNAMIC_CURRENT_ENV
  const env =
    process.env.TCB_ENV ||
    process.env.SCF_NAMESPACE ||
    (typeof cloud.DYNAMIC_CURRENT_ENV === 'string' ? cloud.DYNAMIC_CURRENT_ENV : 'unknown')

  return {
    ok: true,
    serverTime: now,
    iso: new Date(now).toISOString(),
    env
  }
}
