import { defineStore } from 'pinia'
import {
  cloud,
  db,
  rebuildForAccount,
  initDataLayer,
  currentDbName,
  ensureCloudFirstBind,
  pendingFirstBindInfo,
  resolveFirstBind as applyFirstBind,
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
    /**
     * S5-7 首绑裁决：云端已有该账号的数据，等用户选「推本地」还是「留云端」。
     * `null` = 没有待裁决的事。形状：`{ localCount }`（本机待处理的文档数）。
     * UI（「我的」页）看到它非空就弹框，选择结果走 {@link resolveFirstBind}。
     */
    pendingFirstBind: null,
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
     * 退出登录（S5-4）。
     *
     * 规则：**先把改动全部推上云，再清掉本地这份副本**。
     *
     * 为什么这样排：退出之后本机不该再留着上一个账号的账（本地会清空），
     * 所以云端必须是「最新且完整」的那一份。只要还有没推上去的改动，
     * 就**取消退出**并告诉用户原因 —— 宁可退不出去，不可丢账。
     *
     * ⚠️ 匿名身份**不提供退出入口**（MineView 的按钮条件是 `phase === 'formal'`），
     *    因为退出对匿名身份既没意义也没效果：实测（2026-10-01）CloudBase 的匿名身份
     *    是**设备绑定**的，`signOut()` 之后随便一次数据访问都会 `ensureSignedIn()`
     *    把**同一个 uid** 要回来。所以「匿名退出＝永久失联」这个说法**不成立**，
     *    匿名真正的风险只有一个：**清掉浏览器数据**（localStorage 里的登录态没了）。
     *    UI 里那套匿名分支文案已据此删除，只留正式账号一套。
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

      // ② 登出 → 清本地 → 切分区。顺序不能反：
      //    云端登出失败就不该动本地数据（用户还是登录状态，数据得留着）。
      //
      // ⚠️ 切分区**不能写死 null**：退出的只是「手机号那层身份」，设备随后
      //    立刻又会拿到一个**匿名身份**（CloudBase 的匿名会话不随 signOut 消失，
      //    随便一次数据访问都会 `ensureSignedIn` 把它要回来）。
      //    写死 null 会落到未认证分区 `ledger_anon`，而 store 里 uid 却是那个匿名账号，
      //    于是「uid 是 A、库是 ledger_anon」错位 —— 用户看到的是**别的**历史数据，
      //    还会莫名弹一次首绑裁决。所以先问明退出后的身份是谁，再按它选分区。
      return this.runIdentityChange(async () => {
        const res = await cloud.signOut()
        await db.clearLocalData()
        let uid = null
        try {
          uid = await cloud.ensureSignedIn()
        } catch (e) {
          uid = null // 离线 / 匿名登录失败：退回未认证分区，不阻断退出
        }
        await this.switchPartition(uid || null)
        return res
      })
    },

    /**
     * 身份变动后的统一收尾。把「切分区 → 首绑判定 → 同步 → 刷新 store 状态」
     * 收敛成一处，免得三个入口各写一遍、漏掉其中一步。
     *
     * ⚠️ 首绑判定可能是「等用户裁决」（`needs-decision`）—— 那种情况**先不同步**：
     *    同步的第一件事就是 pull，会把云端那份拉下来，用户再选「留云端」
     *    固然没问题，但选「推本地」时看到的已经不是「本机原来的数据」了。
     *    裁决结果由 UI 消费（`pendingFirstBind`），选完再同步。
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

        const bind = await ensureCloudFirstBind().catch(() => null)
        if (bind?.reason === 'needs-decision') {
          this.pendingFirstBind = { localCount: bind.localCount || 0 }
        } else {
          this.pendingFirstBind = null
          // 用 manual 跳过「离线就不发请求」，因为这是用户主动要的结果
          await syncEngine.sync({ reason: 'account-change', manual: true }).catch(() => {})
        }

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
     * 补一次首绑判定（进「我的」页时调）。
     *
     * 为什么需要它：`main.js` 启动时也跑 `ensureCloudFirstBind()`，但那次的返回值
     * 没人接住，紧接着引擎的 startup 同步还会把水位线写回去 —— 之后再判定就短路成
     * `already-synced` 了，用户**永远等不到那个弹框**。所以判定结果会落成 meta 标记
     * （`firstBindPending`），这里先读标记，没有再实探一次。
     *
     * 已经处理过的分区会走 `already-bound` 短路，**不会**再探测云端，代价极小。
     */
    async checkFirstBindDecision() {
      if (this.pendingFirstBind) return this.pendingFirstBind

      const flagged = await pendingFirstBindInfo().catch(() => null)
      if (flagged) {
        this.pendingFirstBind = flagged
        return flagged
      }

      const bind = await ensureCloudFirstBind().catch(() => null)
      if (bind?.reason === 'needs-decision') {
        this.pendingFirstBind = { localCount: bind.localCount || 0 }
      }
      return this.pendingFirstBind
    },

    /**
     * 执行首绑裁决（S5-7），两条路各自同步一次（在 api 层里做）。
     * 裁决会改本地数据，所以之后要把各 store 的已加载标记作废重读。
     *
     * @param {'push-local'|'keep-cloud'} choice
     */
    async resolveFirstBind(choice) {
      if (!this.pendingFirstBind) return null
      if (this.busy) throw new Error('正在处理上一个账号操作，请稍候')
      this.busy = true
      this.error = null
      try {
        const res = await applyFirstBind(choice)
        this.pendingFirstBind = null
        await this.resetLoadedStores()
        await this.refreshIdentity()
        return res
      } catch (e) {
        this.error = (e && e.message) || String(e)
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
     *
     * `start()` 是幂等的（内部 `if (started) return stop`），所以这里**无条件调**：
     * 库名没变（`changed: false`）也可能需要重启 —— 比如 S5-4「退出登录清空本地、
     * 之后又登回同一个账号」，那套引擎在上次切走时已经被 stop，不重启就再也不会自动同步。
     */
    async switchPartition(uid) {
      const { changed } = rebuildForAccount(uid)
      this.dbName = currentDbName()
      syncEngine.start()
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
