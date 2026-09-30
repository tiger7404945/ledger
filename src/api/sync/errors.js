/**
 * 同步错误分类
 * ------------------------------------------------------------
 * 解决的问题：现在所有同步失败都跳同一个「同步失败」红字，但它们的**正确处置
 * 方式完全不同** ——
 *
 *   - 没网：**静默重试**就行，不该打扰用户（他本来就知道自己断网了）
 *   - 登录态失效：要**重新登录**再重试，光退避没用，会永远失败
 *   - 服务端 5xx：退避重试，同时可以提示「稍后再试」
 *   - 配额 / 权限被拒：**重试没有意义**，要停下并告诉用户
 *   - 字段冲突：属于数据问题，得走合并流程，不是「重试」能解决的
 *
 * 全归成一类的结果是三个都做错：断网时反复弹红字、登录失效时无限退避、
 * 配额用完时还在闷头重试烧资源点。
 *
 * ## 设计约束
 *
 * 1. **分类只写一份**。这里给出 `classifyError()`，适配器负责**打标记**、
 *    引擎负责**按类别决策**、视图负责**显示文案**。三方都不自己判错误码。
 * 2. **不依赖错误字符串匹配做主要判断**。优先看适配器打的 `code` / `kind` 标记；
 *    正则兜底只是为了兼容那些没有标记的意外异常（比如 SDK 内部抛的）。
 * 3. **类别是稳定契约**，`kind` 取值只增不改 —— 视图按它选文案，改了会静默失配。
 */

/** 错误类别。`kind` 是这个枚举里的值，视图与引擎都按它分支 */
export const SYNC_ERROR_KIND = {
  /** 云端没配置（没填 envId / 没注入 cloud）。不算错误，是「纯本地模式」 */
  NOT_CONFIGURED: 'not-configured',
  /** 浏览器报告离线，或请求根本没发出去 */
  OFFLINE: 'offline',
  /** 网络层失败（fetch 抛错、DNS、超时）。与 offline 的区别是「网是通的但没到」*/
  NETWORK: 'network',
  /** 登录态失效 / 匿名登录被拒。**必须重新登录**，退避重试无用 */
  AUTH_EXPIRED: 'auth-expired',
  /** 服务端 5xx 或云函数异常。退避重试有意义 */
  SERVER: 'server',
  /** 配额耗尽（免费额度）、频率限制（QPS）。**重试有害**，要停下等额度恢复 */
  QUOTA: 'quota',
  /** 权限被拒（安全规则不允许）。**重试无用**，属于配置问题 */
  FORBIDDEN: 'forbidden',
  /** 文档主键冲突（E11000）。属于数据问题，要走合并/换 id，不是重试 */
  CONFLICT: 'conflict',
  /** 未知。按 SERVER 处理（保守：可重试） */
  UNKNOWN: 'unknown'
}

/**
 * 每类错误的处置策略。**这是「分类」这件事的唯一出口** ——
 * 引擎、视图、测试都读这张表，不要各自写 `if (kind === ...)` 的散装逻辑。
 *
 * - `retryable`    —— 自动退避重试是否有意义
 * - `needsReauth`  —— 是否要先重新登录再试
 * - `silent`       —— 是否不该打扰用户（离线类就是这种）
 * - `label`        —— 给用户看的一句话（视图可直接用）
 */
export const ERROR_POLICY = {
  [SYNC_ERROR_KIND.NOT_CONFIGURED]: {
    retryable: false,
    needsReauth: false,
    silent: true,
    label: '未配置云端，当前为纯本地模式'
  },
  [SYNC_ERROR_KIND.OFFLINE]: {
    retryable: true,
    needsReauth: false,
    silent: true,
    label: '当前离线，恢复网络后会自动同步'
  },
  [SYNC_ERROR_KIND.NETWORK]: {
    retryable: true,
    needsReauth: false,
    silent: false,
    label: '网络不稳定，正在重试'
  },
  [SYNC_ERROR_KIND.AUTH_EXPIRED]: {
    retryable: false,
    // 关键：靠退避永远好不了，必须重新登录
    needsReauth: true,
    silent: false,
    label: '登录状态已失效，正在重新登录'
  },
  [SYNC_ERROR_KIND.SERVER]: {
    retryable: true,
    needsReauth: false,
    silent: false,
    label: '云端暂时不可用，稍后会自动重试'
  },
  [SYNC_ERROR_KIND.QUOTA]: {
    // 重试有害：额度用完时继续打只会在恢复后形成请求尖峰
    retryable: false,
    needsReauth: false,
    silent: false,
    label: '云端额度已用完，同步暂停'
  },
  [SYNC_ERROR_KIND.FORBIDDEN]: {
    retryable: false,
    needsReauth: false,
    silent: false,
    label: '云端拒绝了这次同步，请检查权限配置'
  },
  [SYNC_ERROR_KIND.CONFLICT]: {
    retryable: false,
    needsReauth: false,
    silent: false,
    label: '数据冲突，请重试一次'
  },
  [SYNC_ERROR_KIND.UNKNOWN]: {
    retryable: true,
    needsReauth: false,
    silent: false,
    label: '同步失败，稍后会自动重试'
  }
}

/** 取一个类别的处置策略。未知类别按 UNKNOWN 兜底，永不返回 undefined */
export function policyOf(kind) {
  return ERROR_POLICY[kind] || ERROR_POLICY[SYNC_ERROR_KIND.UNKNOWN]
}

/**
 * 从任意异常里嗅探错误码。
 *
 * CloudBase 的错误在不同层会挂在不同字段上，实测见过的：
 *   - `err.code`         —— SDK 自定义码，如 `'EXCEED_AUTHORITY'` / `'DATABASE_REQUEST_FAILED'`
 *   - `err.error.code`   —— 包了一层的结果对象
 *   - `err.errCode`      —— 老 SDK 的驼峰
 *   - `err.message`      —— 最后兜底
 */
function rawCodeOf(err) {
  if (!err) return ''
  const parts = [
    err.code,
    err.errCode,
    err.error?.code,
    err.error?.errCode,
    err.cause?.code,
    err.message
  ].filter((x) => typeof x === 'string' && x.length)
  return parts.join(' | ')
}

/** 从异常里取 HTTP 状态码（可能在多个位置） */
function statusOf(err) {
  const v = err?.status ?? err?.statusCode ?? err?.response?.status ?? err?.httpStatus
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 把任意异常分类。
 *
 * **优先信适配器打的标记**（`err.kind`）—— 适配器最清楚自己抛的是什么。
 * 没有标记才靠码/状态码嗅探。两条路都失败就是 UNKNOWN（可重试，保守）。
 *
 * @param {*} err 抛出来的东西（可能是 Error、字符串、甚至 null）
 * @param {{ online?: boolean }} [ctx] 上下文。`online === false` 时直接判离线
 * @returns {string} SYNC_ERROR_KIND 里的值
 */
export function classifyError(err, { online } = {}) {
  // 离线优先：网断了就没必要再解析错误码了
  if (online === false) return SYNC_ERROR_KIND.OFFLINE

  // 适配器的显式标记最可信
  if (err && typeof err.kind === 'string' && ERROR_POLICY[err.kind]) return err.kind

  const code = rawCodeOf(err)
  const status = statusOf(err)

  // —— 没配置：不是错误 ——
  if (/no-cloud|not-configured|缺少 env|未配置/i.test(code)) {
    return SYNC_ERROR_KIND.NOT_CONFIGURED
  }

  // —— 登录态 ——
  // EXCEED_AUTHORITY 是实测遇到的（匿名登录被安全规则拒），
  // 其余是常见的登录失效码。
  if (
    /EXCEED_AUTHORITY|NOT_LOGIN|UNAUTHENTICATED|INVALID_CREDENTIAL|登录态|未登录|signInAnonymously|auth.*expired/i.test(
      code
    ) ||
    status === 401
  ) {
    return SYNC_ERROR_KIND.AUTH_EXPIRED
  }

  // —— 配额 / 限流 ——
  // EXCEED_QUOTA 实测存在于 CloudBase（免费额度 3000 点/月）。
  if (/EXCEED_QUOTA|QUOTA|RATE_LIMIT|FREQUENCY|TOO_MANY|限流|频率|额度/i.test(code) || status === 429) {
    return SYNC_ERROR_KIND.QUOTA
  }

  // —— 主键冲突 ——
  // ⚠️ 这条现在**不该再出现**：S4-7 之后云端 `_id` 带了账号前缀。
  //    留着是为了万一出现时能明确归类，而不是混进 UNKNOWN 里盲目重试。
  if (/E11000|duplicate key|主键冲突/i.test(code)) return SYNC_ERROR_KIND.CONFLICT

  // —— 权限 ——
  if (/PERMISSION|FORBIDDEN|DENIED|UNAUTHORIZED|DATABASE_PERMISSION|无权限/i.test(code) || status === 403) {
    return SYNC_ERROR_KIND.FORBIDDEN
  }

  // —— 网络层 ——
  // fetch 在断网/跨域/DNS 失败时抛 TypeError；不同浏览器措辞不同。
  if (
    err instanceof TypeError ||
    /Failed to fetch|NetworkError|network error|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timeout|aborted/i.test(code)
  ) {
    return SYNC_ERROR_KIND.NETWORK
  }

  // —— 服务端 ——
  if (status >= 500) return SYNC_ERROR_KIND.SERVER
  if (/DATABASE_REQUEST_FAILED|INTERNAL|SERVER_ERROR|云函数 HTTP/i.test(code)) {
    return SYNC_ERROR_KIND.SERVER
  }

  return SYNC_ERROR_KIND.UNKNOWN
}

/**
 * 统一成一个带 kind 的错误对象，供引擎与视图消费。
 * 保留原始 `cause` 便于排查，但展示层只看 `kind` + `message`。
 */
export function toSyncError(err, ctx) {
  const kind = classifyError(err, ctx)
  const message =
    (err && (err.message || (typeof err === 'string' ? err : ''))) || String(err || '未知错误')
  const out = new Error(message)
  out.kind = kind
  out.policy = policyOf(kind)
  out.cause = err && typeof err === 'object' ? err : undefined
  out.at = Date.now()
  return out
}
