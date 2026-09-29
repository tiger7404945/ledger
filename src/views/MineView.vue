<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useCategoryStore } from '@/stores/category.js'
import { useBillStore } from '@/stores/bill.js'
import { db, DATA_SOURCE, cloud, syncEngine } from '@/api'
import { useToast } from '@/composables/useToast.js'
import { clearRecordDraft } from '@/composables/useRecordDraft.js'
import AppHeader from '@/components/AppHeader.vue'
import IconBase from '@/components/icons/IconBase.vue'
import TabBar from '@/components/TabBar.vue'

const router = useRouter()
const categoryStore = useCategoryStore()
const billStore = useBillStore()
const toast = useToast()

const pending = ref(0)
const syncState = ref(syncEngine.state)
let offSync = null

const entries = [
  { icon: 'settings', label: '分类管理', desc: '一级 / 二级分类的增删改', to: '/category' },
  { icon: 'piggy', label: '账本管理', desc: '多账本与共享（后续版本）' },
  { icon: 'cloudOff', label: '离线缓存', desc: 'IndexedDB 本地存储（已启用）' },
  { icon: 'sync', label: '云端同步', desc: '腾讯云开发增量同步（S3 接入）' },
  { icon: 'star', label: '关于', desc: '随手记账 · 前端演示版 v0.2' }
]

/** 本地存储的呈现随数据源变化，避免界面写着 A、实际跑着 B */
const storageLabel = DATA_SOURCE === 'idb' ? 'IndexedDB（ledger 库）' : '内存 + localStorage'
const cacheLabel = DATA_SOURCE === 'idb' ? '已启用' : '未启用（仍是内存）'

const SYNC_STATE_LABEL = {
  idle: '空闲',
  syncing: '同步中',
  error: '同步失败',
  offline: '离线'
}
const syncLabel = computed(() => SYNC_STATE_LABEL[syncState.value] || syncState.value)

/** 云端那一行：没接入就说清楚，接入了就说当前状态 */
const cloudLabel = computed(() => {
  if (!cloud) return '未接入（S3 接腾讯云开发）'
  if (syncState.value === 'syncing') return '同步中…'
  if (syncState.value === 'error') return '同步失败，稍后自动重试'
  if (syncState.value === 'offline') return '离线，联网后自动补推'
  return pending.value ? `待推 ${pending.value} 条` : '已同步'
})

onMounted(async () => {
  await db.ready?.()
  await Promise.all([categoryStore.ensureLoaded(), billStore.ensureLoaded()])
  // 队列方法已改为异步，而且「全貌」（状态 / 待推数 / 上次同步时间）只有引擎知道，
  // 所以这里订阅引擎，而不是直接问 outbox。订阅时会立刻回调一次当前状态。
  offSync = syncEngine.onStateChange((s) => {
    syncState.value = s.state
    pending.value = s.pendingCount
  })
})

onUnmounted(() => {
  offSync?.()
  offSync = null
})

async function handleEntry(entry) {
  if (entry.to) {
    router.push(entry.to)
    return
  }
  if (entry.label === '离线缓存') {
    toast.show(`当前数据源：${DATA_SOURCE}，账单存在 ${storageLabel}`)
    return
  }
  if (entry.label === '云端同步') {
    toast.show(
      cloud
        ? `同步状态：${syncLabel.value}，待推 ${pending.value} 条`
        : `待推 ${pending.value} 条，队列已就绪；云端待 S3 接入腾讯云开发`
    )
    return
  }
  toast.show('该功能将在后续版本开放')
}

async function resetDemo() {
  await db.reset()
  clearRecordDraft()
  billStore.resetPeriod()
  await Promise.all([categoryStore.ensureLoaded(true), billStore.ensureLoaded()])
  await Promise.all([billStore.refresh(), billStore.refreshPeriod()])
  pending.value = await db.sync.pendingCount()
  toast.success('演示数据已重置')
}
</script>

<template>
  <div class="page mine-page">
    <AppHeader title="我的" />

    <div class="page-body">
      <section class="card profile">
        <span class="avatar">默</span>
        <div class="profile-info">
          <span class="name">本地用户</span>
          <span class="sub">数据仅保存在本机 · 未登录</span>
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
        </ul>
        <button class="reset" type="button" @click="resetDemo">重置演示数据</button>
      </section>
    </div>

    <TabBar />
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
  padding: 8px 0;
  font-size: 13px;
  border-bottom: 1px dashed var(--hairline);
}

.status-list li:last-child {
  border-bottom: none;
}

.status-list em {
  font-style: normal;
  color: var(--ink-3);
}

.reset {
  width: 100%;
  height: 40px;
  margin-top: 12px;
  border-radius: var(--r-pill);
  background: var(--surface-3);
  color: var(--ink-2);
  font-size: 14px;
}
</style>
