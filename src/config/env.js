/**
 * 运行时配置（前端）
 * ------------------------------------------------------------
 * ⚠️ **只有以 `VITE_` 开头的变量才会被 Vite 注入前端代码。**
 *    没有这个前缀的变量在 `import.meta.env` 上永远是 `undefined` —— 这是 Vite
 *    的刻意设计（免得把服务端密钥误打进浏览器包）。所以新增前端可见的配置项，
 *    名字必须带 `VITE_` 前缀。
 *
 * 集中在这里读一次，其它文件不要再直接碰 `import.meta.env`：
 * 散落着读，改配置时永远找不全，也没法在「未配置」时统一降级。
 *
 * 云端配置缺失时**不抛错、不白屏**：应用继续用本地数据跑，只是不同步
 * （同步引擎拿到 `cloud = null` 时会直接跳过，见 src/api/index.js）。
 */

/** 只在有 env 时取值；Node 里跑脚本时 `import.meta.env` 是 undefined，别写死访问 */
const env = import.meta.env || {}

/** 腾讯云开发（CloudBase）环境 ID，形如 `my-cloudbase-xxxxxxxxxxxx` */
export const cloudEnvId = String(env.VITE_CLOUDBASE_ENV || '').trim()

/**
 * 云函数 HTTP 网关基址（不带尾斜杠），形如
 * `https://<envId>-<rand>.ap-shanghai.app.tcloudbase.com`。
 *
 * 为什么需要它：Web SDK 在匿名登录态下调 `callFunction` 会被
 * `EXCEED_AUTHORITY` 拒绝（见 src/config/cloud.js 的说明），所以云函数走
 * HTTP 网关访问。基址是**平台分配的域名**，不能从 envId 拼出来，必须显式配置。
 */
export const cloudApiBase = String(env.VITE_CLOUDBASE_API_BASE || '')
  .trim()
  .replace(/\/+$/, '')

/** 是否配置了云端。false → 不同步，纯本地记账 */
export const isCloudConfigured = cloudEnvId.length > 0

/** 是否配了 HTTP 网关基址（S4-2 的云函数调用需要它） */
export const isCloudApiConfigured = cloudApiBase.length > 0

/** 构建模式（development / production），仅用于日志与提示 */
export const APP_MODE = String(env.MODE || 'development')

export const IS_DEV = Boolean(env.DEV)
