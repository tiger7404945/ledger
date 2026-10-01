<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useCategoryStore } from '@/stores/category.js'
import { useBillStore } from '@/stores/bill.js'
import { useAccountStore, ACCOUNT_PHASE } from '@/stores/account.js'
import { db, DATA_SOURCE, cloud, syncEngine, ensureCloudFirstBind } from '@/api'
import { useToast } from '@/composables/useToast.js'
import { clearRecordDraft } from '@/composables/useRecordDraft.js'
import AppHeader from '@/components/AppHeader.vue'
import IconBase from '@/components/icons/IconBase.vue'
import TabBar from '@/components/TabBar.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const router = useRouter()
const categoryStore = useCategoryStore()
const billStore = useBillStore()
const account = useAccountStore()
const toast = useToast()

const pending = ref(0)
const syncState = ref(syncEngine.state)
let offSync = null
let offAuth = null

const entries = [
  { icon: 'settings', label: '分类管理', desc: '一级 / 二级分类的增删改', to: '/category' },
  { icon: 'piggy', label: '账本管理', desc: '多账本与共享（后续版本）' },
  { icon: 'cloudOff', label: '离线缓存', desc: 'IndexedDB 本地存储（已启用）' },
  { icon: 'sync', label: '云端同步', desc: '腾讯云开发增量同步（已接入）' },
  { icon: 'star', label: '关于', desc: '随手记账 · 本地优先记账 v0.5' }
]

/** 本地存储的呈现随数据源与分区变化，避免界面写着 A、实际跑着 B */
const storageLabel = computed(() => {
  if (DATA_SOURCE !== 'idb') return '内存 + localStorage'
  return account.dbName ? `IndexedDB（${account.dbName}）` : 'IndexedDB'
})
const cacheLabel = DATA_SOURCE === 'idb' ? '已启用' : '未启用（仍是内存）'

/** 云端那一行：没接入就说清楚，接入了就说当前状态 */
const cloudLabel = computed(() => {
  if (!cloud) return '未配置（纯本地记账）'
  if (syncState.value === 'syncing') return '同步中…'
  if (syncState.value === 'error') return '同步失败，稍后自动重试'
  if (syncState.value === 'offline') return '离线，联网后自动补推'
  return pending.value ? `待推 ${pending.value} 条` : '已同步'
})

/**
 * 个人卡片那行说明。
 * ⚠️ 匿名身份必须**明确写出风险**（清掉浏览器就找不回）——
 *    这是 S5 做「转正」的全部理由，藏在代码注释里没用，得让用户看见。
 */
const profileSub = computed(() => {
  if (!cloud) return '数据仅保存在本机 · 未配置云端'
  if (!account.ready) return '本地优先 · 正在确认账号…'
  if (account.phase === ACCOUNT_PHASE.ANONYMOUS) return '本地优先 · 匿名身份，清浏览器即失效'
  if (account.phase === ACCOUNT_PHASE.FORMAL) return '本地优先 · 已绑定手机号，换设备可找回'
  return '本地优先 · 未登录，数据只在本机'
})

const avatarText = computed(() => (account.phase === ACCOUNT_PHASE.FORMAL ? '我' : '默'))

/* ---------------- 登录弹层 ---------------- */

const sheetOpen = ref(false)
/** 弹层模式：login（换账号登录）| upgrade（匿名转正） */
const sheetMode = ref('login')
const formPhone = ref('')
const formCode = ref('')
const codeSent = ref(false)
const countdown = ref(0)
/**
 * 发码返回的 `{ verification_id, is_user }`。
 * ⚠️ 登录时必须带回去 —— 它是服务端用来配对「这条验证码属于哪次请求」的凭据，
 *    丢了 `signInWithSms` 内部的 verify() 会因 verification_id 为空而失败。
 */
const verificationInfo = ref(null)
let countdownTimer = null

/** 退出登录确认框（S5-4）：正式账号与匿名账号两套文案，见 signOutMessage */
const signOutOpen = ref(false)
const signOutTitle = computed(() =>
  account.phase === ACCOUNT_PHASE.FORMAL ? '退出登录' : '退出匿名账号'
)
const signOutMessage = computed(() =>
  account.phase === ACCOUNT_PHASE.FORMAL
    ? '退出后会清空本机的账目数据（云端已保存完整副本），下次用手机号登录即可恢复。'
    : '匿名身份一旦退出就找不回来了 —— 云端那份副本同样进不去。建议先绑定手机号再退出。'
)

const sheetTitle = computed(() =>
  sheetMode.value === 'upgrade' ? '绑定手机号' : '手机号登录'
)

const sheetHint = computed(() =>
  sheetMode.value === 'upgrade'
    ? '绑定后当前账号与数据原地保留，换设备用手机号即可找回。'
    : '登录会切换到该手机号名下的数据；本机当前未登录的数据仍留在原分区。'
)

const canSubmit = computed(
  () => /^1[3-9]\d{9}$/.test(formPhone.value) && formCode.value.length >= 4 && !account.busy
)

function openSheet(mode) {
  if (!cloud) {
    toast.show('未配置云端（见 .env.local），无法登录')
    return
  }
  sheetMode.value = mode
  formPhone.value = mode === 'upgrade' ? account.phone || '' : ''
  formCode.value = ''
  codeSent.value = false
  sheetOpen.value = true
}

function closeSheet() {
  sheetOpen.value = false
  stopCountdown()
  account.error = null
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
  countdown.value = 0
}

/**
 * 发验证码。两种模式走的是**两条完全不同的路**（混用必失败，踩过）：
 * - 登录模式：getVerification 发码 → verificationInfo 留给 signInWithSms 配对。
 * - 转正模式：短信由 signUp 自己发（verifyOtp 与它配对），所以这里调的是
 *   `account.prepareUpgrade`。**不要**在这里再调一次 sendSmsCode ——
 *   同号一分钟连发两条会撞频控，而且用户输入的第一条码与 verifyOtp 对不上。
 */
async function sendCode() {
  if (!/^1[3-9]\d{9}$/.test(formPhone.value)) {
    toast.show('请输入正确的手机号')
    return
  }
  try {
    if (sheetMode.value === 'upgrade') {
      await account.prepareUpgrade(formPhone.value)
    } else {
      const res = await account.sendCode(formPhone.value)
      verificationInfo.value = res?.verificationInfo || null
    }
    codeSent.value = true
    countdown.value = 60
    stopCountdown()
    countdownTimer = setInterval(() => {
      countdown.value -= 1
      if (countdown.value <= 0) stopCountdown()
    }, 1000)
    toast.success('验证码已发送')
  } catch (e) {
    toast.show(`发送失败：${e?.message || e}`)
  }
}

async function submit() {
  if (!canSubmit.value) return
  try {
    if (sheetMode.value === 'upgrade') {
      await account.upgradeWithPhone({ phone: formPhone.value, code: formCode.value })
      toast.success('已绑定手机号，数据完好')
    } else {
      await account.signInWithPhone({
        phone: formPhone.value,
        code: formCode.value,
        verificationInfo: verificationInfo.value
      })
      toast.success('登录成功')
    }
    closeSheet()
    pending.value = await db.sync.pendingCount()
  } catch (e) {
    toast.show(`${sheetMode.value === 'upgrade' ? '绑定' : '登录'}失败：${e?.message || e}`)
  }
}

async function handleSignOut() {
  // 退出登录的后果不一样，先确认（S5-4）：
  //   正式账号 —— 本地副本清空，云端有完整一份，登回来即可；
  //   匿名账号 —— 退出 = 永久失联（云端那份自己也进不去），必须警告。
  signOutOpen.value = true
}

async function doSignOut() {
  try {
    await account.signOut()
    await Promise.all([billStore.refresh(), billStore.refreshPeriod()])
    pending.value = await db.sync.pendingCount()
    toast.success('已退出登录，本地数据已清空')
  } catch (e) {
    toast.show(`退出失败：${e?.message || e}`)
  }
}

/* ---------------- 首次绑定裁决（S5-7） ---------------- */

/**
 * 首绑裁决的文案。云端已有数据时，本机这份不再被无脑覆盖上去，先问用户。
 * 条数来自 store（`pendingFirstBind.localCount`，本机三个集合里的文档数）。
 */
const firstBindMessage = computed(() => {
  const n = account.pendingFirstBind?.localCount ?? 0
  return `该账号云端已经有数据。本机这份数据共 ${n} 条，要把它也同步到云端吗？选择「保留云端」将舍弃本机数据（云端数据不受影响）。`
})

async function decideFirstBind(choice) {
  try {
    const r = await account.resolveFirstBind(choice)
    await Promise.all([billStore.refresh(), billStore.refreshPeriod()])
    pending.value = await db.sync.pendingCount()
    if (choice === 'keep-cloud') toast.success('已保留云端数据，本机数据已舍弃')
    else toast.success(`已同步本机数据（${r?.queued || 0} 条入队）`)
  } catch (e) {
    toast.show(`处理失败：${e?.message || e}`)
  }
}

onMounted(async () => {
  await account.bootstrap()
  await db.ready?.()
  await Promise.all([categoryStore.ensureLoaded(), billStore.ensureLoaded()])
  // 补一次首绑裁决判定：启动阶段（main.js）那次不负责弹框，
  // 这里发现「云端已有数据且本机还没裁决过」就把弹框拉起来
  await account.checkFirstBindDecision().catch(() => {})
  // 队列方法已改为异步，而且「全貌」（状态 / 待推数 / 上次同步时间）只有引擎知道，
  // 所以这里订阅引擎，而不是直接问 outbox。订阅时会立刻回调一次当前状态。
  offSync = syncEngine.onStateChange((s) => {
    syncState.value = s.state
    pending.value = s.pendingCount
  })
  // 登录态变化时同步刷新 store（账号可能在别处被改，比如引擎自己重新登录）
  if (cloud?.onAuthChange) {
    offAuth = cloud.onAuthChange(() => {
      account.refreshIdentity()
    })
  }
  pending.value = await db.sync.pendingCount().catch(() => 0)
})

onUnmounted(() => {
  offSync?.()
  offSync = null
  offAuth?.()
  offAuth = null
  stopCountdown()
})

async function handleEntry(entry) {
  if (entry.to) {
    router.push(entry.to)
    return
  }
  if (entry.label === '离线缓存') {
    toast.show(`当前数据源：${DATA_SOURCE}，账单存在 ${storageLabel.value}`)
    return
  }
  if (entry.label === '云端同步') {
    if (!cloud) {
      toast.show(`待推 ${pending.value} 条，队列已就绪；但没配云端（见 .env.local）`)
      return
    }
    await syncNow()
    return
  }
  toast.show('该功能将在后续版本开放')
}

/** 手动同步。manual: true 跳过「离线就不发请求」的判断 —— 是用户主动要试的 */
async function syncNow() {
  if (!cloud) {
    toast.show('没配云端（见 .env.local）')
    return
  }
  const r = await syncEngine.sync({ reason: 'manual', manual: true })
  if (r?.ok) toast.success(`已同步：上行 ${r.pushed}、下行 ${r.pulled}`)
  else if (r?.skipped) toast.show(`已跳过：${r.reason}`)
  else toast.show(`同步失败：${r?.error?.message || '未知错误'}`)
  pending.value = await db.sync.pendingCount()
  return r
}

async function resetDemo() {
  // 顺序不能反：
  //   ① 先把本地清掉、重新播种（这一步会清空 outbox、水位线与首次绑定标记）
  //   ② 再把云端清掉 —— 不然后面同步会把刚清掉的旧数据原样拉回来，
  //      看起来就像「重置按钮没生效」
  //   ③ 最后重新绑定 + 同步，把新的演示数据送上去
  await db.reset()
  if (cloud?.wipe) {
    try {
      await cloud.wipe()
    } catch (e) {
      toast.show(`云端清理失败：${e?.message || e}`)
    }
  }
  clearRecordDraft()
  billStore.resetPeriod()
  await Promise.all([categoryStore.ensureLoaded(true), billStore.ensureLoaded()])
  await Promise.all([billStore.refresh(), billStore.refreshPeriod()])
  if (cloud) {
    await ensureCloudFirstBind().catch(() => {})
    await syncEngine.sync({ reason: 'manual', manual: true }).catch(() => {})
  }
  pending.value = await db.sync.pendingCount()
  toast.success('演示数据已重置')
}
</script>

<template>
  <div class="page mine-page">
    <AppHeader title="我的" />

    <div class="page-body">
      <section class="card profile">
        <span class="avatar">{{ avatarText }}</span>
        <div class="profile-info">
          <span class="name">本地用户</span>
          <span class="sub">{{ profileSub }}</span>
        </div>
      </section>

      <!-- 账号卡片：只在配了云端时出现（没云端就没有账号概念） -->
      <section v-if="cloud" class="card account">
        <header class="account-head">
          <span class="account-label">{{ account.label }}</span>
          <span v-if="account.phase === 'anonymous'" class="pill warn">未绑定</span>
          <span v-else-if="account.phase === 'formal'" class="pill ok">已绑定</span>
        </header>
        <p class="account-hint">
          <template v-if="account.phase === 'anonymous'">
            匿名身份只存在于这台浏览器，清除数据或换设备后将无法找回这些账目。
          </template>
          <template v-else-if="account.phase === 'formal'">
            数据与手机号绑定，换设备登录即可继续记账。
          </template>
          <template v-else>登录后可在多台设备之间同步账目。</template>
        </p>
        <div class="actions">
          <button
            v-if="account.canUpgrade"
            class="primary"
            type="button"
            :disabled="account.busy"
            @click="openSheet('upgrade')"
          >
            绑定手机号
          </button>
          <button
            v-else-if="account.phase !== 'formal'"
            class="primary"
            type="button"
            :disabled="account.busy"
            @click="openSheet('login')"
          >
            登录 / 注册
          </button>
          <button
            v-if="account.phase === 'formal'"
            class="ghost"
            type="button"
            :disabled="account.busy"
            @click="handleSignOut"
          >
            退出登录
          </button>
        </div>
      </section>

      <section class="card list">
        <button
          v-for="entry in entries"
          :key="entry.label"
          class="row"
          type="button"
          @click="handleEntry(entry)"
        >
          <span class="row-icon"><IconBase :name="entry.icon" :size="19" /></span>
          <span class="row-text">
            <span class="row-label">{{ entry.label }}</span>
            <span class="row-desc">{{ entry.desc }}</span>
          </span>
          <IconBase name="chevronRight" :size="15" :stroke-width="1.8" class="chev" />
        </button>
      </section>

      <section class="card status">
        <header class="status-head">
          <span class="section-title">数据层状态</span>
          <span class="tag">{{ DATA_SOURCE }}</span>
        </header>
        <ul class="status-list">
          <li><em>本地存储</em><span>{{ storageLabel }}</span></li>
          <li><em>待同步队列</em><span>{{ pending }} 条</span></li>
          <li><em>离线缓存</em><span>{{ cacheLabel }}</span></li>
          <li><em>云端</em><span>{{ cloudLabel }}</span></li>
          <li><em>云端账号</em><span>{{ account.label }}</span></li>
        </ul>
        <div class="actions">
          <button class="ghost" type="button" @click="syncNow">立即同步</button>
          <button class="ghost" type="button" @click="resetDemo">重置演示数据</button>
        </div>
      </section>
    </div>

    <TabBar />

    <!-- 手机号登录 / 绑定弹层 -->
    <Teleport to="body">
      <div v-if="sheetOpen" class="sheet-mask" @click.self="closeSheet">
        <div class="sheet">
          <header class="sheet-head">
            <span class="sheet-title">{{ sheetTitle }}</span>
            <button class="sheet-close" type="button" @click="closeSheet">
              <IconBase name="close" :size="17" />
            </button>
          </header>
          <p class="sheet-desc">{{ sheetHint }}</p>

          <label class="field">
            <span class="field-label">手机号</span>
            <input
              v-model.trim="formPhone"
              class="field-input"
              type="tel"
              inputmode="numeric"
              maxlength="11"
              placeholder="请输入 11 位手机号"
            />
          </label>

          <label class="field">
            <span class="field-label">验证码</span>
            <span class="field-code">
              <input
                v-model.trim="formCode"
                class="field-input"
                type="text"
                inputmode="numeric"
                maxlength="6"
                placeholder="6 位验证码"
              />
              <button
                class="code-btn"
                type="button"
                :disabled="countdown > 0 || !/^1[3-9]\d{9}$/.test(formPhone)"
                @click="sendCode"
              >
                {{ countdown > 0 ? `${countdown}s` : codeSent ? '重新发送' : '获取验证码' }}
              </button>
            </span>
          </label>

          <p v-if="account.error" class="sheet-error">{{ account.error }}</p>

          <button class="submit" type="button" :disabled="!canSubmit" @click="submit">
            {{ account.busy ? '处理中…' : sheetMode === 'upgrade' ? '确认绑定' : '登录' }}
          </button>
        </div>
      </div>
    </Teleport>

    <!-- 退出登录确认（S5-4）：正式账号与匿名账号两套文案 -->
    <ConfirmDialog
      v-model="signOutOpen"
      :title="signOutTitle"
      :message="signOutMessage"
      confirm-text="退出"
      :danger="account.phase !== 'formal'"
      @confirm="doSignOut"
    />

    <!--
      首绑裁决（S5-7）：云端已有数据时才出现，由 store 的 pendingFirstBind 驱动。
      刻意不用 v-model —— 关闭由「裁决完成」决定，用户在选完之前关不掉；
      遮罩也不响应（maskClosable=false），避免手滑替用户做选择。
    -->
    <ConfirmDialog
      :model-value="Boolean(account.pendingFirstBind)"
      :mask-closable="false"
      title="云端已有数据"
      :message="firstBindMessage"
      confirm-text="同步本地"
      cancel-text="保留云端"
      @confirm="decideFirstBind('push-local')"
      @cancel="decideFirstBind('keep-cloud')"
    />
  </div>
</template>

<style scoped>
.page-body {
  /* 底部留出标签栏高度，否则最后一屏内容会被固定的 TabBar 盖住 */
  padding: 4px 14px var(--tabbar-space);
}

.profile {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 16px;
}

.avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand-ink);
  font-size: 20px;
  font-weight: 600;
}

.profile-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.name {
  font-size: 16px;
  font-weight: 500;
}

.sub {
  font-size: 12.5px;
  color: var(--ink-3);
}

/* ---- 账号卡片 ---- */
.account {
  margin-top: 12px;
  padding: 16px;
}

.account-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.account-label {
  flex: 1;
  font-size: 15px;
  font-weight: 500;
}

.pill {
  padding: 2px 9px;
  border-radius: var(--r-pill);
  font-size: 11.5px;
}

.pill.warn {
  background: var(--brand-soft);
  color: var(--brand-ink);
}

.pill.ok {
  background: var(--brand-soft);
  color: var(--brand-ink);
}

.account-hint {
  margin-top: 8px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-3);
}

.primary {
  flex: 1;
  height: 40px;
  border-radius: var(--r-pill);
  background: var(--brand);
  color: #fff;
  font-size: 14px;
  font-weight: 500;
}

.primary:disabled,
.submit:disabled,
.code-btn:disabled {
  opacity: 0.45;
}

.list {
  margin-top: 12px;
  padding: 0 16px;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px 0;
  border-bottom: 1px solid var(--hairline);
  text-align: left;
}

.row:last-child {
  border-bottom: none;
}

.row-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: var(--surface-3);
  color: var(--ink-2);
}

.row-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.row-label {
  font-size: 14.5px;
}

.row-desc {
  font-size: 12px;
  color: var(--ink-3);
}

.chev {
  color: var(--ink-4);
}

.status {
  margin-top: 12px;
  padding: 16px;
}

.status-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.tag {
  padding: 2px 8px;
  border-radius: var(--r-pill);
  background: var(--brand-soft);
  color: var(--brand-ink);
  font-size: 11.5px;
}

.status-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  font-size: 13px;
  border-bottom: 1px dashed var(--hairline);
}

.status-list li:last-child {
  border-bottom: none;
}

.status-list em {
  flex: none;
  font-style: normal;
  color: var(--ink-3);
}

.status-list span {
  text-align: right;
  word-break: break-all;
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.ghost {
  flex: 1;
  height: 40px;
  border-radius: var(--r-pill);
  background: var(--surface-3);
  color: var(--ink-2);
  font-size: 14px;
}

/* ---- 登录 / 绑定弹层 ---- */
.sheet-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}

.sheet {
  width: min(var(--frame-w), 100%);
  padding: 18px 20px calc(20px + var(--safe-b));
  border-radius: 18px 18px 0 0;
  background: var(--surface-raised, #fff);
}

.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sheet-title {
  font-size: 16px;
  font-weight: 600;
}

.sheet-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--ink-3);
}

.sheet-desc {
  margin-top: 6px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-3);
}

.field {
  display: block;
  margin-top: 14px;
}

.field-label {
  display: block;
  margin-bottom: 6px;
  font-size: 12.5px;
  color: var(--ink-3);
}

.field-input {
  width: 100%;
  height: 44px;
  padding: 0 14px;
  border-radius: var(--r-md);
  background: var(--surface-3);
  font-size: 15px;
  color: var(--ink);
}

.field-code {
  display: flex;
  align-items: center;
  gap: 8px;
}

.field-code .field-input {
  flex: 1;
}

.code-btn {
  flex: none;
  height: 44px;
  padding: 0 14px;
  border-radius: var(--r-md);
  background: var(--brand-soft);
  color: var(--brand-ink);
  font-size: 13px;
}

.sheet-error {
  margin-top: 10px;
  font-size: 12.5px;
  color: #d94a3d;
}

.submit {
  width: 100%;
  height: 46px;
  margin-top: 18px;
  border-radius: var(--r-pill);
  background: var(--brand);
  color: #fff;
  font-size: 15px;
  font-weight: 500;
}
</style>
