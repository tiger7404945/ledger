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
     * 注销账号（S8-4）：**不可逆**地清掉这个账号在云端与本机的全部数据。
     *
     * ## 顺序（错一步就清不干净，且都是静默出错）
     *
     *   ① **先清云端** —— 登出后没有身份，`wipe()` 会抛 `NOT_SIGNED_IN`，
     *      一条都删不掉；用户以为注销了，数据其实完整留在云上；
     *   ② **再删本机分区** —— 必须在切分区**之前**，因为「删哪个库」取决于
     *      当前指针指向哪个分区；切到 guest 之后再删就把 guest 库删了；
     *   ③ **最后登出 + 切回未登录分区**。
     *
     * ## 与 `signOut()` 的取舍正好相反
     *
     * `signOut()` 是「先保数据再清」：有没推上去的改动就**取消退出**（宁可退不出去，
     * 不可丢账）。注销不能这么做 —— 用户的意图就是「这些数据我不要了」，
     * 为了「保住」它们而拦住注销是南辕北辙。云端那份反正马上要被清掉，
     * 先推一轮毫无意义还多写一遍。
     *
     * ## 注销后本机与云端各剩什么
     *
     *   - 本机：该账号的分区被清回**出厂态**（业务表全清、建库标记与水位线一并
     *     抹掉、旧版遗留的 localStorage 键也清掉），落到 `ledger_guest` ——
     *     那里有账本 + 42 条分类，能看能算不能写；
     *   - 云端：三个集合里属于本账号的文档全部删除；
     *   - **平台侧的账号记录会保留**（Web SDK 的 `auth.deleteUser` 要求密码，
     *     而短信登录的账号从来没有密码，客户端删不掉）。之后再拿同一个手机号
     *     登录会得到一个**全新的空账本** —— 所以对用户而言数据确实不可恢复。
     *
     * @returns {Promise<{wiped: Object}>} `wiped` = 各云端集合实际删掉的条数，
     *   形如 `{ ledger_ledgers: 1, ledger_categories: 42, ledger_bills: 17 }`
     */
    async deleteAccount() {
      if (!cloud) throw new Error('未配置云端，没有可注销的账号')
      if (!this.signedIn) throw new Error('当前未登录，没有可注销的账号')

      return this.runIdentityChange(async () => {
        // ① 云端：清空本账号的全部文档（必须在登出之前，见方法头）
        const wiped = (await cloud.deleteAccount?.()) || {}
        // ② 本机：分区清回出厂态（必须在切分区之前 —— 切完指针就指向 guest 了）
        await db.deleteLocalData?.()
        // ③ 身份：登出 → 落到未登录分区
        await cloud.signOut()
        await this.switchPartition(null)
        return { wiped }
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

        // ⚠️ 上面这轮 sync 的 pull 可能把云端数据写进了新分区（**重新登录必然如此**
        //    —— 退出时清过本地）。而上面的 resetLoadedStores 是在 sync **之前**跑的，
        //    它读到的是「登录瞬间的空库」，且各 store 的 initialized 已被置真，
        //    之后页面再怎么切都不会重读（真机实测：重登后分类宫格空白，账单只是
        //    恰好踩中 period 切片的一次性加载才回来）。所以这里必须再刷一次，
        //    让 store 吃到回拉结果。失败也不阻塞登录流程（下次进页面还有兜底）。
        await this.resetLoadedStores().catch(() => {})

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
      // ⚠️ period 切片有**独立的**守卫标志，漏了它的话账单页 / 统计页会一直显示
      //    上一个分区（乃至上一个账号）的区间数据 —— ensurePeriodLoaded 会直接 no-op
      bill.periodInitialized = false
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
