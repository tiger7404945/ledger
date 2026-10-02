<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useCategoryStore } from '@/stores/category.js'
import { useBillStore } from '@/stores/bill.js'
import { useAccountStore } from '@/stores/account.js'
import { db, DATA_SOURCE, cloud, syncEngine } from '@/api'
import { useToast } from '@/composables/useToast.js'
import { openLoginSheet } from '@/composables/useLoginSheet.js'
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
  if (account.signedIn) return '本地优先 · 换设备登录可找回'
  return '本地优先 · 数据只在本机'
})

const avatarText = computed(() => {
  if (!cloud) return '本'
  return account.signedIn ? '我' : '未'
})

/** 头像下方的说明段：把「未登录的风险 / 登录的收益」一句说透 */
const profileHint = computed(() => {
  if (!cloud) return ''
  if (account.signedIn) {
    return '数据与手机号绑定，换设备登录即可继续记账；未同步的改动会在恢复网络后自动补推。'
  }
  return '未登录时数据只保存在本机（清除浏览器数据会丢失）。登录后可同步到云端，多台设备共用一套账。'
})

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
          <p class="profile-hint">{{ profileHint }}</p>
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
