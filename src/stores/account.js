import { defineStore } from 'pinia'
import {
  cloud,
  db,
  rebuildForAccount,
  initDataLayer,
  currentDbName,
  enqueueLocalForCloud,
  syncEngine
} from '@/api'
import { useBillStore } from './bill.js'
import { useCategoryStore } from './category.js'
import { useLedgerStore } from './ledger.js'

/**
 * 账号 store（S5-1 + S5-5，S7 简化）
 * ------------------------------------------------------------
 * 它把三件事**按正确顺序**绑在一起，这是本文件存在的唯一理由：
 *
 *   1. **登录 / 登出**（走 cloud 适配器的账号能力）
 *   2. **切换本地数据分区**（`rebuildForAccount`，库名 = `ledger_<账号前缀>`）
 *   3. **重建后重新绑定 + 同步**（否则新分区的数据要么上不去、要么拉不下来）
 *
 * 为什么必须集中在这里：这三步之间**顺序错了会静默串号**。
 * 比如「先同步再切库」会把 A 的队列推给 B；「切了库不重新绑定」会让新账号
 * 看不到自己刚继承来的数据。分散在组件里迟早会写错一处，且很难复现。
 *
 * ## S7：匿名身份已移除
 *
 * 登录态从三态收敛成**两态**：
 *   - `formal`     已登录（手机号）
 *   - `signedOut`  未登录（没配云端时也是这个）
 *
 * 随之删掉的是「匿名 → 转正」的整套东西（`prepareUpgrade` / `upgradeWithPhone`、
 * `isAnonymous` / `canUpgrade`）与「首绑裁决」（云端已有数据时问用户推哪份）。
 * 未登录时用户待在 `ledger_guest` 分区，能看能算、不能写（写操作由 UI 的
 * 登录门禁拦住，见 `composables/useLoginGate.js`）。
 */

/** 登录态阶段 */
export const ACCOUNT_PHASE = {
  FORMAL: 'formal',
  SIGNED_OUT: 'signedOut'
}

export const useAccountStore = defineStore('account', {
  state: () => ({
    /** 当前 uid（未登录为 null） */
    uid: null,
    /** 已登录的手机号 */
    phone: null,
    /** 当前本地分区库名（UI 显示，便于排查「我到底在读哪个库」） */
    dbName: null,
    /** 是否正在执行登录 / 登出这类会改身份的操作 */
    busy: false,
    /** 最近一次失败的提示（UI 直接显示） */
    error: null,
    /** 是否已完成一次身份探测（避免 UI 在探测前就把「未登录」显示出来） */
    ready: false
  }),

  getters: {
    /** 两态 */
    phase(state) {
      return state.uid ? ACCOUNT_PHASE.FORMAL : ACCOUNT_PHASE.SIGNED_OUT
    },

    /** 是否有云端（没配云端时整个账号面板都不该出现登录入口） */
    hasCloud() {
      return Boolean(cloud)
    },

    /** 是否已登录 */
    signedIn(state) {
      return Boolean(state.uid)
    },

    /**
     * 给 UI 显示的一行账号标签。
     * ⚠️ 手机号**打码**（138****0000）：这是我自己的号，但截图分享 / 别人瞄一眼时
     *    没必要全露。uid 也只露前 8 位。
     */
    label(state) {
      if (!state.uid) return '未登录'
      return state.phone ? `手机号 ${maskPhone(state.phone)}` : `已登录 · ${String(state.uid).slice(0, 8)}`
    }
  },

  actions: {
    /**
     * 启动时探测一次身份 + 确定分区。**不创建任何账号**。
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
        this.phone = null
        return
      }
      const id = await cloud.getIdentity().catch(() => null)
      this.uid = id?.uid || null
      this.phone = id?.phone || null
    },

    /** 发登录验证码。返回 verificationInfo，登录时要带回去 */
    async sendCode(phone) {
      if (!cloud?.sendSmsCode) throw new Error('未配置云端，无法发送验证码')
      this.error = null
      return cloud.sendSmsCode(phone)
    },

    /**
     * 手机验证码登录（可能**换账号**）。
     *
     * ⚠️ 顺序：登录 → 切分区 → 重新绑定 → 同步。
     *    切分区必须在登录**之后**（要用新 uid 算库名），
     *    同步必须在绑定**之后**（绑定把本地已有数据入队，同步才有东西可推）。
     *
     * ⚠️ **换号必须先退出**：当前 UI 就是「先退出再登录」，这是有意的 ——
     *    退出会把本地清空 + 清水位线，于是登录时的分区必然是空库、必然全量回拉。
     *    若改成「直接登录换号」，新账号的分区里可能留着上一个账号的数据
     *    （分区按账号隔离，但同一个 uid 重新登录时会命中同一个库）。
     *    别把这条「顺手优化」掉。
     */
    async signInWithPhone({ phone, code, verificationInfo }) {
      return this.runIdentityChange(async () => {
        const res = await cloud.signInWithSms({ phone, code, verificationInfo })
        await this.switchPartition(res.uid)
        return res
      })
    },

    /**
     * 退出登录（S5-4）。
     *
     * 规则：**先把改动全部推上云，再清掉本地这份副本**。
     *
     * 为什么这样排：退出之后本机不该再留着上一个账号的账（本地会清空），
     * 所以云端必须是「最新且完整」的那一份。只要还有没推上去的改动，
     * 就**取消退出**并告诉用户原因 —— 宁可退不出去，不可丢账。
     *
     * ⚠️ S7 之前这里退出后还要 `ensureSignedIn()` 问一次「设备随即拿到的匿名
     *    身份是谁」，因为那时匿名登录态不随 signOut 消失，写死 null 会和
     *    真实的匿名 uid 错位（看到别的分区的数据）。去掉匿名身份后这条
     *    顾虑不存在了：退出就是未登录，落到 `ledger_guest`。
     */
    async signOut() {
      if (!cloud) throw new Error('未配置云端，没有可退出的登录态')

      // ① 保数据：有未推送的改动就先推一轮，推不干净不往下走
      const before = await db.sync.pendingCount().catch(() => 0)
      if (before > 0) {
        const r = await syncEngine
          .sync({ reason: 'before-signout', manual: true })
          .catch((e) => ({ ok: false, error: e }))
        const left = await db.sync.pendingCount().catch(() => 0)
        if (!r?.ok || left > 0) {
          const why = r?.error?.message || r?.reason || '未知原因'
          throw new Error(`还有 ${left || before} 条改动没同步到云端，已取消退出（${why}）`)
        }
      }

      // ② 登出 → 清本地 → 切到未登录分区。顺序不能反：
      //    云端登出失败就不该动本地数据（用户还是登录状态，数据得留着）。
      return this.runIdentityChange(async () => {
        const res = await cloud.signOut()
        await db.clearLocalData()
        await this.switchPartition(null)
        return res
      })
    },

    /**
     * 身份变动后的统一收尾。把「切分区 → 本地入队 → 同步 → 刷新 store 状态」
     * 收敛成一处，免得两个入口各写一遍、漏掉其中一步。
     *
     * ## 为什么是「本地入队」而不是以前的首绑裁决（S7-7）
     *
     * 登录后的账号分区里，本地会先播一份**基础设施**（账本 + 默认分类，S7-9）。
     * 它们是适配器直写的、不在 outbox 里，必须补一次 `enqueueAll()` 才能推上云
     * —— 否则全新账号的默认分类永远上不了云，换设备登录就是空宫格。
     *
     * S5-7 的裁决（「云端已有数据，推本地还是留云端？」）随之删除：那个问题
     * 只在**匿名身份下**才成立（匿名分区里攒了一堆本地账，转正后云端可能已有
     * 别人的数据）。现在未登录不写数据、登录必然先退出清本地，云端不可能出现
     * 「两边都有内容」的局面，裁决也就没有意义了。
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

        // 只有**已登录**才有「把本地推上云」这件事：未登录分区（guest）不同步
        if (cloud?.signedIn) await enqueueLocalForCloud().catch(() => 0)

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
     * 切换本地数据分区并（在已登录时）重启同步。
     *
     * 重建之后要显式 `start()`：`rebuildForAccount` 会先把旧引擎 `stop()`，
     * 新引擎是「停着」的状态。不停旧引擎不行 —— 它醒来会把**旧账号的队列**
     * 推出去，那正是要防的串号。
     *
     * ⚠️ **未登录时反而要 `stop()`**（S7-3）：未登录的分区没有可同步的内容，
     *    而且云端适配器在没有登录态时会直接抛 `NOT_SIGNED_IN`；引擎开着只会
     *    让 UI 一直显示「同步失败」。登录成功时再由 `runIdentityChange` 拉起。
     *
     * `start()` / `stop()` 都是幂等的，所以这里无条件调。
     */
    async switchPartition(uid) {
      const { changed } = rebuildForAccount(uid)
      this.dbName = currentDbName()

      if (uid) syncEngine.start()
      else syncEngine.stop()

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
