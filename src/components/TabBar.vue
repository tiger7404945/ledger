<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import IconBase from './icons/IconBase.vue'

const route = useRoute()
const router = useRouter()

const tabs = [
  { key: 'home', label: '首页', icon: 'home', to: '/' },
  { key: 'bills', label: '账单', icon: 'bill', to: '/bills' },
  { key: 'add', label: '', icon: 'plus', to: '/record' },
  { key: 'stats', label: '统计', icon: 'stats', to: '/stats' },
  { key: 'mine', label: '我的', icon: 'user', to: '/mine' }
]

const activeKey = computed(() => {
  const path = route.path
  if (path.startsWith('/bills')) return 'bills'
  if (path.startsWith('/stats')) return 'stats'
  if (path.startsWith('/mine')) return 'mine'
  return 'home'
})

function go(tab) {
  if (tab.key === 'add') {
    router.push('/record')
    return
  }
  if (activeKey.value !== tab.key) router.push(tab.to)
}
</script>

<template>
  <nav class="tabbar">
    <button
      v-for="tab in tabs"
      :key="tab.key"
      class="tab"
      :class="{ 'is-active': activeKey === tab.key, 'is-add': tab.key === 'add' }"
      @click="go(tab)"
    >
      <template v-if="tab.key === 'add'">
        <span class="plus">
          <IconBase name="plus" :size="26" :stroke-width="2" />
        </span>
      </template>
      <template v-else>
        <IconBase :name="tab.icon" :size="23" :stroke-width="activeKey === tab.key ? 1.8 : 1.5" />
        <span class="label">{{ tab.label }}</span>
      </template>
    </button>
  </nav>
</template>

<style scoped>
.tabbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 40;
  display: flex;
  align-items: flex-end;
  height: calc(var(--tab-h) + var(--safe-b));
  padding-bottom: var(--safe-b);
  background: #fff;
  box-shadow: 0 -1px 0 var(--hairline);
}

.tab {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: var(--tab-h);
  color: var(--ink-3);
  font-size: 10px;
  transition: color 0.15s ease;
}

.tab.is-active {
  color: var(--brand-700);
}

.tab .label {
  line-height: 1;
}

.tab.is-add {
  position: relative;
  justify-content: flex-end;
  overflow: visible;
}

.plus {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 54px;
  height: 54px;
  border-radius: 50%;
  background: var(--dark);
  color: #fff;
  box-shadow: 0 6px 16px rgba(16, 16, 16, 0.24);
  transition: transform 0.15s ease;
}

.tab.is-add:active .plus {
  transform: translateX(-50%) scale(0.94);
}
</style>
