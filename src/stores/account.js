import { defineStore } from 'pinia'
import {
  cloud,
  rebuildForAccount,
  initDataLayer,
  currentDbName,
  ensureCloudFirstBind,
  syncEngine
} from '@/api'
import { useBillStore } from './bill.js'
import { useCategoryStore } from './category.js'
import { useLedgerStore } from './ledger.js'

/**
 * 账号 store（S5-1 + S5-5）
 * ------------------------------------------------------------
 * 它把三件事**按正确顺序**绑在一起，这是本文件存在的唯一理由：
 *
 *   1. **登录 / 转正 / 登出**（走 cloud 适配器的账号能力）
 *   2. **切换本地数据分区**（`rebuildForAccount`，库名 = `ledger_<账号前缀>`）
 *   3. **重建后重新绑定 + 同步**（否则新分区的数据要么上不去、要么拉不下来）
 *
 * 为什么必须集中在这里：这三步之间**顺序错了会静默串号**。
 * 比如「先同步再切库」会把 A 的队列推给 B；「切了库不重新绑定」会让新账号
 * 看不到自己刚继承来的数据。分散在组件里迟早会写错一处，且很难复现。
 *
 * 登录态有三种，UI 要能区分（`phase`）：
 *   - `anonymous`  匿名（设备身份）—— 数据在云端，但**清掉浏览器就找不回**
 *   - `formal`     正式账号（手机号）
 *   - `signedOut`  未登录（没配云端时也是这个）
 */

/** 登录态阶段 */
export const ACCOUNT_PHASE = {
  ANONYMOUS: 'anonymous',
  FORMAL: 'formal',
  SIGNED_OUT: 'signedOut'
}

export const useAccountStore = defineStore('account', {
  state: () => ({
    /** 当前 uid（未登录为 null） */
    uid: null,
    /** 是否匿名身份 */
    isAnonymous: false,
    /** 已绑定的手机号（正式账号才有） */
    phone: null,
    /** 当前本地分区库名（UI 显示，便于排查「我到底在读哪个库」） */
    dbName: null,
    /** 是否正在执行登录/转正/登出这类会改身份的操作 */
    busy: false,
    /** 最近一次失败的提示（UI 直接显示） */
    error: null,
    /** 是否已完成一次身份探测（避免 UI 在探测前就把「未登录」显示出来） */
    ready: false
  }),

  getters: {
    /** 三态 */
    phase(state) {
      if (!state.uid) return ACCOUNT_PHASE.SIGNED_OUT
      return state.isAnonymous ? ACCOUNT_PHASE.ANONYMOUS : ACCOUNT_PHASE.FORMAL
    },

    /** 是否有云端（没配云端时整个账号面板都不该出现登录入口） */
    hasCloud() {
      return Boolean(cloud)
    },

    /** 是否已登录（含匿名） */
    signedIn(state) {
      return Boolean(state.uid)
    },

    /**
     * 给 UI 显示的一行账号标签。
     * ⚠️ 手机号**打码**（138****0000）：这是我自己的号，但截图分享/别人瞄一眼时
     *    没必要全露。uid 也只露前 8 位。
     */
    label(state) {
      if (!state.uid) return '未登录'
      if (state.isAnonymous) return `匿名 · ${String(state.uid).slice(0, 8)}`
      return state.phone ? `手机号 ${maskPhone(state.phone)}` : '正式账号'
    },

    /** 是否需要展示「转正」引导 */
    canUpgrade(state) {
      return Boolean(cloud) && state.uid && state.isAnonymous
    }
  },

  actions: {
    /**
     * 启动时探测一次身份 + 确定分区。**不创建匿名账号**（见 api/index.js 的说明）。
     * main.js 已经调过 initDataLayer，这里主要是把结果同步进 store，
     * 顺带处理「main.js 还没跑完、UI 已经挂载」的竞态（重复调用是幂等的）。
     */
    async bootstrap() {
      await initDataLayer().catch(() => {})
      await this.refreshIdentity()
      this.ready = true
      return this.phase
    },

    /** 只读一次身份，不动任何数据分区 */
    async refreshIdentity() {
      this.dbName = currentDbName()
      if (!cloud?.getIdentity) {
        // 没配云端 ⇒ 没有账号概念，保持「未登录」但本地照常可用
        this.uid = null
        this.isAnonymous = false
        this.phone = null
        return
      }
      const id = await cloud.getIdentity().catch(() => null)
      this.uid = id?.uid || null
      this.isAnonymous = Boolean(id?.isAnonymous)
      this.phone = id?.phone || null
    },

    /**
     * 发验证码（**登录模式**用）。返回 verificationInfo，登录时要带回去。
     * 转正模式走 {@link prepareUpgrade} —— 那边短信由 signUp 自己发，
     * 两者的验证码会话不能混用（见 cloudbaseAdapter 的翻车记录）。
     */
    async sendCode(phone) {
      if (!cloud?.sendSmsCode) throw new Error('未配置云端，无法发送验证码')
      this.error = null
      return cloud.sendSmsCode(phone)
    },

    /**
     * 转正第一步：触发 signUp —— **短信在这条调用里发出（唯一一条）**。
     * 返回的 verifyOtp 回调暂存在适配器里，等 confirmUpgrade 消费。
     */
    async prepareUpgrade(phone) {
      if (!cloud?.prepareUpgrade) throw new Error('未配置云端，无法发送验证码')
      this.error = null
      return cloud.prepareUpgrade({ phone })
    },

    /**
     * 手机验证码登录（可能**换账号**）。
     *
     * ⚠️ 顺序：登录 → 切分区 → 重新绑定 → 同步。
     *    切分区必须在登录**之后**（要用新 uid 算库名），
     *    同步必须在绑定**之后**（绑定把本地已有数据入队，同步才有东西可推）。
     */
    async signInWithPhone({ phone, code, verificationInfo }) {
      return this.runIdentityChange(async () => {
        const res = await cloud.signInWithSms({ phone, code, verificationInfo })
        await this.switchPartition(res.uid)
        return res
      })
    },

    /**
     * 匿名 → 正式账号（手机号绑定）——转正第二步，前面必须先 `prepareUpgrade`。
     *
     * **uid 不变**，所以理论上不用切分区；但仍然走一遍 switchPartition ——
     * 它内部会比对库名，相同就直接返回（`changed: false`），代价只是一次字符串比较。
     * 这样「万一某天 SDK 行为变了、转正换了 uid」也不会漏切。
     *
     * ⚠️ 转正返回的手机号要落进 store，UI 才能从「匿名」变成「手机号 138****」。
     */
    async upgradeWithPhone({ phone, code } = {}) {
      return this.runIdentityChange(async () => {
        const res = await cloud.confirmUpgrade({ code, phone })
        await this.switchPartition(res.uid)
        return res
      })
    },

    /**
     * 退出登录。
     *
     * ⚠️ **只登出、只切分区，不删任何数据**。「退出后本地数据怎么办」
     *    是 S5-4 的产品决策（清掉 / 保留 / 下次登录还看得见），
     *    在没定下来之前保持现状最安全 —— 用户登回去还能看到自己的账。
     *    登出后落到「未认证分区」，那个分区里通常什么都没有（干净的开始）。
     */
    async signOut() {
      return this.runIdentityChange(async () => {
        const res = await cloud.signOut()
        await this.switchPartition(null)
        return res
      })
    },

    /**
     * 身份变动后的统一收尾。把「切分区 → 重新绑定 → 同步 → 刷新 store 状态」
     * 收敛成一处，免得三个入口各写一遍、漏掉其中一步。
     *
     * @param {Function} mutate 真正执行身份操作的回调
     */
    async runIdentityChange(mutate) {
      if (this.busy) throw new Error('正在处理上一个账号操作，请稍候')
      this.busy = true
      this.error = null
      try {
        const res = await mutate()
        // 切库后所有「已加载」标记都要作废，否则页面还显示上一个账号的数据
        await this.resetLoadedStores()
        await ensureCloudFirstBind().catch(() => {})
        // 用 manual 跳过「离线就不发请求」，因为这是用户主动要的结果
        await syncEngine.sync({ reason: 'account-change', manual: true }).catch(() => {})
        await this.refreshIdentity()
        return res
      } catch (e) {
        this.error = (e && e.message) || String(e)
        await this.refreshIdentity()
        throw e
      } finally {
        this.busy = false
      }
    },

    /**
     * 切换本地数据分区并重启同步。
     *
     * 重建之后要显式 `start()`：`rebuildForAccount` 会先把旧引擎 `stop()`，
     * 新引擎是「停着」的状态。不停旧引擎不行 —— 它醒来会把**旧账号的队列**
     * 推出去，那正是要防的串号。
     */
    async switchPartition(uid) {
      const { changed } = rebuildForAccount(uid)
      this.dbName = currentDbName()
      if (changed) {
        syncEngine.start()
      }
      return { changed, dbName: this.dbName }
    },

    /** 把各 store 的「已加载」标记清掉，强制下一次进入页面重新从（新分区的）库读 */
    async resetLoadedStores() {
      const bill = useBillStore()
      const category = useCategoryStore()
      const ledger = useLedgerStore()
      ledger.initialized = false
      category.initialized = false
      bill.initialized = false
      bill.resetPeriod()
      await Promise.all([ledger.ensureLoaded(), category.ensureLoaded(true), bill.ensureLoaded()])
    }
  }
})

/** 手机号打码：13800000000 → 138****0000 */
function maskPhone(phone) {
  const p = String(phone || '')
  if (p.length < 7) return p
  return `${p.slice(0, 3)}****${p.slice(-4)}`
}
