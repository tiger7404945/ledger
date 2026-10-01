<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useCategoryStore } from '@/stores/category.js'
import { useBillStore } from '@/stores/bill.js'
import { useAccountStore, ACCOUNT_PHASE } from '@/stores/account.js'
import { db, DATA_SOURCE, cloud, syncEngine } from '@/api'
import { IS_DEV } from '@/config/env.js'
import { useToast } from '@/composables/useToast.js'
import { clearRecordDraft } from '@/composables/useRecordDraft.js'
import { openLoginSheet } from '@/composables/useLoginSheet.js'
import { requireLogin } from '@/composables/useLoginGate.js'
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
 * 个人卡片那行说明。
 *
 * ⚠️ S7 去掉了匿名身份，这里只剩两句：**已登录**（数据跟着手机号走）与
 *    **未登录**（数据只在本机）。别再写「匿名身份清浏览器即失效」——
 *    那个身份已经不存在了，现在「未登录」本身就把风险说清楚了。
 */
const profileSub = computed(() => {
  if (!cloud) return '数据仅保存在本机 · 未配置云端'
  if (!account.ready) return '本地优先 · 正在确认账号…'
  if (account.phase === ACCOUNT_PHASE.FORMAL) return '本地优先 · 已登录，换设备可找回'
  return '本地优先 · 未登录，数据只在本机'
})

const avatarText = computed(() => (account.phase === ACCOUNT_PHASE.FORMAL ? '我' : '默'))

/**
 * 头像右侧的标题。
 *
 * ⚠️ 不能写死「本地用户」：S7 之前只有匿名一种身份，写死看不出来；
 *    现在登录态下它旁边就是「已登录」，还写「本地用户」就自相矛盾了。
 *    具体手机号由下面账号卡的 `account.label` 承担，这里只给一个身份层级词。
 */
const profileName = computed(() => (account.phase === ACCOUNT_PHASE.FORMAL ? '我的账号' : '本地用户'))

/** 退出登录确认框（S5-4）：本地副本会被清掉（云端保留完整一份），先确认 */
const signOutOpen = ref(false)
const signOutTitle = '退出登录'
const signOutMessage = '退出后会清空本机的账目数据（云端已保存完整副本），下次用手机号登录即可恢复。'

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

onMounted(async () => {
  await account.bootstrap()
  await db.ready?.()
  await Promise.all([categoryStore.ensureLoaded(), billStore.ensureLoaded()])
  // 队列方法已改为异步，而且「全貌」（状态 / 待推数 / 上次同步时间）只有引擎知道，
  // 所以这里订阅引擎，而不是直接问 outbox。订阅时会立刻回调一次当前状态。
  offSync = syncEngine.onStateChange((s) => {
    syncState.value = s.state
    pending.value = s.pendingCount
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
  if (entry.label === '离线缓存') {
    toast.show(`当前数据源：${DATA_SOURCE}，账单存在 ${storageLabel.value}`)
    return
  }
  if (entry.label === '云端同步') {
    if (!cloud) {
      toast.show(`待推 ${pending.value} 条，队列已就绪；但没配云端（见 .env.local）`)
      return
    }
    if (!account.signedIn) {
      openLoginSheet({ reason: '登录后才会把本机数据同步到云端。' })
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

/**
 * 重置演示数据（开发构建专用）。
 *
 * ⚠️ 它会**连云端一起清**，所以要过登录门禁 —— 未登录时云端没有「我的数据」
 *    可清，点了只会白等一轮。生产构建里这个按钮不出现（`v-if="IS_DEV"`）：
 *    生产环境本来就不播演示数据，没有可重置的东西。
 *
 * 顺序不能反：
 *   ① 先把本地清掉、重新播种（会清空 outbox、水位线与入队标记）
 *   ② 再把云端清掉 —— 不然后面同步会把刚清掉的旧数据原样拉回来，
 *      看起来就像「重置按钮没生效」
 *   ③ 最后重新入队 + 同步，把新的演示数据送上去
 */
async function resetDemo() {
  if (!requireLogin('重置演示数据')) return
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
  await db.enqueueAll?.().catch(() => 0)
  if (cloud) await syncEngine.sync({ reason: 'manual', manual: true }).catch(() => {})
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
          <span class="name">{{ profileName }}</span>
          <span class="sub">{{ profileSub }}</span>
        </div>
      </section>

      <!-- 账号卡片：只在配了云端时出现（没云端就没有账号概念） -->
      <section v-if="cloud" class="card account">
        <header class="account-head">
          <!--
            ⚠️ 未登录时**不能**直接用 `account.label`：它和右边的 pill 都是「未登录」，
               会让同一行相邻出现两个一模一样的词。这里换成「本机数据」——
               它说的是数据归属（与下方 hint 呼应），和 pill 的登录状态是两个维度。
          -->
          <span class="account-label">{{ account.signedIn ? account.label : '本机数据' }}</span>
          <span v-if="account.signedIn" class="pill ok">已登录</span>
          <span v-else class="pill warn">未登录</span>
        </header>
        <p class="account-hint">
          <template v-if="account.signedIn">
            数据与手机号绑定，换设备登录即可继续记账；未同步的改动会在恢复网络后自动补推。
          </template>
          <template v-else>
            未登录时数据只保存在本机（清除浏览器数据会丢失）。登录后可同步到云端，多台设备共用一套账。
          </template>
        </p>
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
          <button
            v-else
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
          <!-- 生产构建不显示：那里没有演示数据可重置，而且它会清云端 -->
          <button v-if="IS_DEV" class="ghost" type="button" @click="resetDemo">重置演示数据</button>
        </div>
      </section>
    </div>

    <TabBar />

    <!-- 退出登录确认（S5-4）：本地副本会被清掉 -->
    <ConfirmDialog
      v-model="signOutOpen"
      :title="signOutTitle"
      :message="signOutMessage"
      confirm-text="退出"
      danger
      @confirm="doSignOut"
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
</style>
