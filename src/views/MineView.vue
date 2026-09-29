<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useCategoryStore } from '@/stores/category.js'
import { useBillStore } from '@/stores/bill.js'
import { db, DATA_SOURCE } from '@/api'
import { outbox } from '@/api/sync/outbox.js'
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

const entries = [
  { icon: 'settings', label: '分类管理', desc: '一级 / 二级分类的增删改', to: '/category' },
  { icon: 'piggy', label: '账本管理', desc: '多账本与共享（后续版本）' },
  { icon: 'cloudOff', label: '离线缓存', desc: 'IndexedDB 本地存储（已预留接口）' },
  { icon: 'sync', label: '云端同步', desc: 'LeanCloud 增量同步（已预留接口）' },
  { icon: 'star', label: '关于', desc: '随手记账 · 前端演示版 v0.1' }
]

onMounted(async () => {
  await Promise.all([categoryStore.ensureLoaded(), billStore.ensureLoaded()])
  pending.value = outbox.pendingCount()
})

async function handleEntry(entry) {
  if (entry.to) {
    router.push(entry.to)
    return
  }
  if (entry.label === '离线缓存') {
    toast.show('第二阶段接入 IndexedDB，接口已就绪')
    return
  }
  if (entry.label === '云端同步') {
    toast.show(`待同步 ${pending.value} 条，接口已预留`)
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
  pending.value = outbox.pendingCount()
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
          <li><em>本地存储</em><span>memory + localStorage</span></li>
          <li><em>待同步队列</em><span>{{ pending }} 条</span></li>
          <li><em>离线缓存</em><span>idbAdapter（预留）</span></li>
          <li><em>云端</em><span>leancloudAdapter（预留）</span></li>
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
