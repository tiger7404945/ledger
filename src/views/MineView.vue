<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useCategoryStore } from '@/stores/category.js'
import { useBillStore } from '@/stores/bill.js'
import { useAccountStore } from '@/stores/account.js'
import { db, DATA_SOURCE, cloud, syncEngine } from '@/api'
import { useToast } from '@/composables/useToast.js'
import { openLoginSheet } from '@/composables/useLoginSheet.js'
import { formatClockTime } from '@/utils/date.js'
import AppHeader from '@/components/AppHeader.vue'
import IconBase from '@/components/icons/IconBase.vue'
import TabBar from '@/components/TabBar.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import BackupSheet from '@/components/BackupSheet.vue'

const router = useRouter()
const categoryStore = useCategoryStore()
const billStore = useBillStore()
const account = useAccountStore()
const toast = useToast()

const pending = ref(0)
const syncState = ref(syncEngine.state)
/** 上次成功同步的本地时刻（0 = 本次会话还没成功过）。见 syncEngine 的说明 */
const lastSuccessAt = ref(syncEngine.lastSuccessAt || 0)
const backupOpen = ref(false)
/**
 * 数据层状态区的展开态（默认折叠）。
 *
 * 折叠不是「藏起来」：那一区全是排查用的细节（数据源 / 库名 / 水位线 / 待推条数），
 * 正常记账根本不需要看，摊开反而把「分类管理 / 数据备份」这些真入口挤下去。
 * 需要时点标题展开即可 —— 保留它是因为出问题时它是第一现场。
 */
const statusOpen = ref(false)
let offSync = null
let offAuth = null

/**
 * 列表入口。
 *
 * 「离线缓存」「云端同步」两项已删除（S8-4）——它们是**纯展示**的，
 * 点了只是弹个 toast 复述下面「数据层状态」区里已经写着的东西，
 * 而「同步」动作本来就有状态区里的「立即同步」按钮。留着等于让用户多点一次。
 */
const entries = [
  { icon: 'settings', label: '分类管理', desc: '一级 / 二级分类的增删改', to: '/category' },
  { icon: 'box', label: '数据备份/恢复', desc: '导出为 JSON 文件 / 从备份恢复' },
  { icon: 'piggy', label: '账本管理', desc: '多账本与共享（后续版本）' },
  { icon: 'star', label: '关于', desc: '随手记账 · 本地优先记账 v0.5' }
]

/** 本地存储的呈现随数据源与分区变化，避免界面写着 A、实际跑着 B */
const storageLabel = computed(() => {
  if (DATA_SOURCE !== 'idb') return '内存 + localStorage'
  return account.dbName ? `IndexedDB（${account.dbName}）` : 'IndexedDB'
})
const cacheLabel = DATA_SOURCE === 'idb' ? '已启用' : '未启用（仍是内存）'

/**
 * 云端那一行。
 *
 * ⚠️ 「未登录」要排在最前面（S7-3）：引擎在未登录时**压根不启动**，所以
 *    `syncState` 长期停在 `idle`，若按状态机往下判会显示成「已同步」——
 *    那是在骗人：根本没同步过。未登录就是未登录，直说。
 */
const cloudLabel = computed(() => {
  if (!cloud) return '未配置（纯本地记账）'
  if (!account.signedIn) return '未登录，登录后自动同步'
  if (syncState.value === 'syncing') return '同步中…'
  if (syncState.value === 'error') return syncEngine.lastError?.label || '同步失败，稍后自动重试'
  if (syncState.value === 'offline') return '离线，联网后自动补推'
  return pending.value ? `待推 ${pending.value} 条` : '已同步'
})

/**
 * 上次同步时间（S8-2）。
 *
 * ⚠️ 用 `lastSuccessAt`（本地时刻）而**不是** `lastSyncAt`（水位线）：
 *    后者是服务端时间轴上的值，拿它显示会出现「刚同步完却说上次是昨天」。
 *    两者的区别写在 `syncEngine` 的字段注释里。
 *
 * ⚠️ 未登录时直接说「未登录」而不显示时间：引擎在未登录时压根不启动，
 *    显示「本次尚未同步」会让人以为是坏了。
 */
const lastSyncLabel = computed(() => {
  if (!cloud) return '不支持（纯本地）'
  if (!account.signedIn) return '未登录'
  if (syncState.value === 'syncing') return '进行中…'
  return formatClockTime(lastSuccessAt.value) || '本次尚未同步'
})

/**
 * 失败态才给重试入口，且**只在重试有意义时给**。
 *
 * 「没意义」= 引擎自己都不会再试的类别（配额用完、权限被拒、主键冲突）——
 * 那些错误再点一次还是同样的结果，给按钮等于骗人。判据直接复用引擎放在
 * `lastError.retryable` 上的结论（见 syncEngine 的失败处置）。
 */
const canRetry = computed(
  () => syncState.value === 'error' && syncEngine.lastError?.retryable !== false
)

/**
 * 账号卡（S7 后只有一种卡，两态 + 无云端兜底）。
 *
 * ⚠️ 标题直接用 `account.label`：未登录它就是「未登录」，登录后是
 *    「手机号 138****1234」（或没有手机号时的「已登录 · uid 前 8 位」）——
 *    登录态已经融在文案里，所以不再放重复的 pill。
 */
const profileName = computed(() => (cloud ? account.label : '本地记账'))

const profileSub = computed(() => {
  if (!cloud) return '未配置云端 · 数据仅保存在本机'
  if (!account.ready) return '正在确认账号…'
  if (account.signedIn) return '数据云备份，换机可找回'
  return '请登录后使用'
})

const avatarText = computed(() => {
  if (!cloud) return '本'
  return account.signedIn ? '我' : '未'
})

/**
 * 头像下方的说明段：只在**已登录**时给（解释同步行为）。
 *
 * ⚠️ 未登录时返回空串、整段不渲染：那一句「请登录后使用」已经由 `profileSub`
 *    承担，再渲染一遍就是同一张卡上相邻重复（还紧挨着「登录 / 注册」按钮）。
 *    另外 S7 之后未登录**写不了任何东西**（写操作全被门禁拦住），本机没有
 *    用户数据可丢 —— 过去那句「清除浏览器数据会丢失」的提醒已经过时，删得。
 */
const profileHint = computed(() => {
  if (!cloud || !account.signedIn) return ''
  return '数据与手机号绑定，换设备登录即可继续记账；未同步的改动会在恢复网络后自动补推。'
})

/** 退出登录确认框（S5-4）：本地副本会被清掉（云端保留完整一份），先确认 */
const signOutOpen = ref(false)
const signOutTitle = '退出登录'
const signOutMessage = '退出后会清空本机的账目数据（云端已保存完整副本），下次用手机号登录即可恢复。'

/**
 * 注销账号确认框（S8-4）。
 *
 * ⚠️ **不可点遮罩取消**（`mask-closable="false"`）：这是本 App 里唯一一个
 *    真正不可逆的破坏性操作，手滑点到遮罩就替用户做了决定是不能接受的。
 *
 * ⚠️ 文案里必须**如实交代平台侧账号记录会保留**。只说「永久删除」会让人以为
 *    手机号也一并注销了，之后拿同一个号登录发现还能进（虽然是个空账号），
 *    会觉得「注销没生效」。宁可多说一句，也不要让用户对不可逆操作产生误解。
 */
const deleteAccountOpen = ref(false)
const deleteAccountTitle = '注销账号'
const deleteAccountMessage = [
  '注销会永久删除这个账号在云端与本机的全部账单、分类与账本，且无法恢复。',
  '平台侧的账号记录会保留。之后用同一手机号登录，会得到一份全新的空账本。'
].join('\n\n')

function openLogin() {
  openLoginSheet({ reason: '登录后可在多台设备之间同步账目。' })
}

function handleSignOut() {
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

/**
 * 真的执行注销。**只由确认框的 confirm 事件触发** —— 按钮直接绑到这里是
 * 不可接受的（那等于一键不可逆删除）。`gate-test` 有一条源码守卫盯着这点。
 */
async function doDeleteAccount() {
  try {
    const res = await account.deleteAccount()
    await Promise.all([billStore.refresh(), billStore.refreshPeriod()])
    pending.value = await db.sync.pendingCount().catch(() => 0)
    const cleared = Object.values(res?.wiped || {}).reduce((a, b) => a + Number(b || 0), 0)
    toast.success(cleared ? `账号已注销，云端清除 ${cleared} 条` : '账号已注销，数据已清除')
  } catch (e) {
    toast.show(`注销失败：${e?.message || e}`)
  }
}

onMounted(async () => {
  await account.bootstrap()
  await db.ready?.()
  await Promise.all([categoryStore.ensureLoaded(), billStore.ensureLoaded()])
  // 队列方法已改为异步，而且「全貌」（状态 / 待推数 / 上次同步时间）只有引擎知道，
  // 所以这里订阅引擎，而不是直接问 outbox。订阅时会立刻回调一次当前状态。
  offSync = syncEngine.onStateChange((s) => {
    syncState.value = s.state
    pending.value = s.pendingCount
    lastSuccessAt.value = s.lastSuccessAt || 0
  })
  // 登录态变化时同步刷新 store（账号可能在别处被改，比如登录弹层里刚登录完）
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
})

async function handleEntry(entry) {
  if (entry.to) {
    // 写操作入口（分类管理）：由路由守卫统一拦未登录，这里不用重复判断
    router.push(entry.to)
    return
  }
  if (entry.label === '数据备份/恢复') {
    backupOpen.value = true
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
  // 状态广播可能因为「前后都是 idle」而不触发，这里补一次真值同步
  lastSuccessAt.value = syncEngine.lastSuccessAt || 0
  syncState.value = syncEngine.state
  return r
}
</script>

<template>
  <div class="page mine-page">
    <AppHeader title="我的" />

    <div class="page-body">
      <!--
        账号卡（S7 合并版）：原「个人卡 + 账号卡」合成一张 —— S7 去掉匿名身份后
        不存在「本地账号」，再摆两块只会重复表达同一个登录态。
        结构：头像 + 名称/说明 → 说明段 → 登录/退出按钮。
      -->
      <section class="card profile">
        <div class="profile-head">
          <span class="avatar">{{ avatarText }}</span>
          <div class="profile-info">
            <span class="name">{{ profileName }}</span>
            <span class="sub">{{ profileSub }}</span>
          </div>
        </div>
        <template v-if="cloud">
          <p v-if="profileHint" class="profile-hint">{{ profileHint }}</p>
          <div class="actions">
            <button
              v-if="!account.signedIn"
              class="primary"
              type="button"
              :disabled="account.busy"
              @click="openLogin"
            >
              登录 / 注册
            </button>
            <!--
              退出 / 注销并列。两者差别很容易被误读（都是「离开账号」），
              所以按钮本身写明「注销账号」而不是「删除数据」，确认框里再讲清楚代价。
              注销只放 `open`，真正的执行绑在确认框的 confirm 上。
            -->
            <template v-else>
              <button class="ghost" type="button" :disabled="account.busy" @click="handleSignOut">
                退出登录
              </button>
              <button
                class="ghost danger"
                type="button"
                :disabled="account.busy"
                @click="deleteAccountOpen = true"
              >
                注销账号
              </button>
            </template>
          </div>
        </template>
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

      <!--
        数据层状态（S8-4 起默认折叠）。
        标题整行可点 —— 折叠区比「小箭头」更好按，也更符合「点标题展开」的直觉。
      -->
      <section class="card status">
        <button
          class="status-head"
          type="button"
          :aria-expanded="statusOpen"
          @click="statusOpen = !statusOpen"
        >
          <span class="section-title">数据层状态</span>
          <span class="head-right">
            <span class="tag">{{ DATA_SOURCE }}</span>
            <IconBase
              name="chevronDown"
              :size="15"
              :stroke-width="1.8"
              class="chev"
              :class="{ 'is-open': statusOpen }"
            />
          </span>
        </button>

        <template v-if="statusOpen">
          <ul class="status-list">
            <li><em>本地存储</em><span>{{ storageLabel }}</span></li>
            <li><em>待同步队列</em><span>{{ pending }} 条</span></li>
            <li><em>离线缓存</em><span>{{ cacheLabel }}</span></li>
            <li><em>云端</em><span>{{ cloudLabel }}</span></li>
            <li><em>上次同步</em><span>{{ lastSyncLabel }}</span></li>
            <li><em>云端账号</em><span>{{ account.label }}</span></li>
          </ul>
          <div class="actions">
            <!-- 失败态才把按钮换成主题色并改叫「重试」；不可重试的失败保持灰色 -->
            <button :class="canRetry ? 'primary' : 'ghost'" type="button" @click="syncNow">
              {{ canRetry ? '重试同步' : '立即同步' }}
            </button>
          </div>
        </template>
      </section>
    </div>

    <TabBar />

    <!-- 数据备份（S8-1）：导出 / 从 JSON 恢复 -->
    <BackupSheet v-model="backupOpen" />

    <!-- 退出登录确认（S5-4）：本地副本会被清掉 -->
    <ConfirmDialog
      v-model="signOutOpen"
      :title="signOutTitle"
      :message="signOutMessage"
      confirm-text="退出"
      danger
      @confirm="doSignOut"
    />

    <!--
      注销账号确认（S8-4）。`mask-closable="false"`：不可逆操作，不允许手滑
      点遮罩就取消「已弹出的这个决定」——只能明确选取消或确认。
    -->
    <ConfirmDialog
      v-model="deleteAccountOpen"
      :title="deleteAccountTitle"
      :message="deleteAccountMessage"
      confirm-text="永久注销"
      cancel-text="再想想"
      danger
      :mask-closable="false"
      @confirm="doDeleteAccount"
    />
  </div>
</template>

<style scoped>
.page-body {
  /* 底部留出标签栏高度，否则最后一屏内容会被固定的 TabBar 盖住 */
  padding: 4px 14px var(--tabbar-space);
}

.profile {
  padding: 16px;
}

.profile-head {
  display: flex;
  align-items: center;
  gap: 14px;
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
  min-width: 0;
}

.name {
  font-size: 16px;
  font-weight: 500;
}

.sub {
  font-size: 12.5px;
  color: var(--ink-3);
}

.profile-hint {
  margin-top: 12px;
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

.primary:disabled {
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
  transition: transform 0.18s ease;
}

/* 展开时箭头翻上来 —— 折叠区少一个状态描述，箭头就是那个信号 */
.chev.is-open {
  transform: rotate(180deg);
}

.status {
  margin-top: 12px;
  padding: 16px;
}

.status-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
}

.head-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-list {
  margin-top: 10px;
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

/**
 * 危险幽灵按钮：底色仍走中性（不抢「退出登录」的视觉权重），只把文字染红。
 * 与 ConfirmDialog 里 `.act.primary.danger` 的取色一致 —— 同一个语义在
 * 整个 App 里应该长得一样。
 */
.ghost.danger {
  color: var(--danger);
}

.ghost:disabled {
  opacity: 0.45;
}
</style>
