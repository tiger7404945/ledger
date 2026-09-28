<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useCategoryStore } from '@/stores/category.js'
import { useLedgerStore } from '@/stores/ledger.js'
import { useToast } from '@/composables/useToast.js'
import AppHeader from '@/components/AppHeader.vue'
import IconBase from '@/components/icons/IconBase.vue'
import CategoryGrid from '@/components/CategoryGrid.vue'

const route = useRoute()
const router = useRouter()
const categoryStore = useCategoryStore()
const ledgerStore = useLedgerStore()
const toast = useToast()

const type = ref(route.query.type === 'income' ? 'income' : 'expense')

const primaries = computed(() => categoryStore.primaries(type.value))
const badges = computed(() =>
  primaries.value.filter((c) => categoryStore.hasChildren(c.id)).map((c) => c.id)
)
const items = computed(() =>
  primaries.value.map((c) => ({ id: c.id, name: c.name, icon: c.icon }))
)

onMounted(async () => {
  await Promise.all([ledgerStore.ensureLoaded(), categoryStore.ensureLoaded()])
})

watch(type, (value) => {
  router.replace({ query: { ...route.query, type: value } })
})

function openCategory(item) {
  router.push({ path: `/category/${item.id}/sub`, query: { type: type.value } })
}

function createPrimary() {
  router.push({ path: '/category/edit', query: { scope: 'primary', type: type.value } })
}

function showInfo() {
  toast.show('点击分类可管理其二级分类 · 右上角灰点表示含二级分类', { duration: 2600 })
}
</script>

<template>
  <div class="page manage-page">
    <AppHeader title="分类管理" :back="true">
      <template #right>
        <button class="icon-btn" aria-label="说明" @click="showInfo">
          <IconBase name="info" :size="20" />
        </button>
      </template>
    </AppHeader>

    <div class="page-body">
      <div class="filter-row">
        <span class="chip is-on ledger-chip">
          <IconBase name="checkbox-on" :size="14" :stroke-width="1.4" />
          {{ ledgerStore.currentName }}
        </span>

        <div class="segmented">
          <button
            class="seg"
            :class="{ 'is-active': type === 'expense' }"
            type="button"
            @click="type = 'expense'"
          >
            支出
          </button>
          <button
            class="seg"
            :class="{ 'is-active': type === 'income' }"
            type="button"
            @click="type = 'income'"
          >
            收入
          </button>
        </div>
      </div>

      <CategoryGrid
        class="manage-grid"
        :items="items"
        :badges="badges"
        :icon-size="44"
        @select="openCategory"
      />
    </div>

    <footer class="footer">
      <button class="btn-dark" type="button" @click="createPrimary">新建一级分类</button>
    </footer>

    <!-- 二级分类管理以底部弹层形式叠在本页之上 -->
    <router-view />
  </div>
</template>

<style scoped>
.manage-page {
  background: var(--page);
}

.page-body {
  padding: 0 14px;
  padding-bottom: 84px;
}

.filter-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 0 14px;
}

.ledger-chip {
  height: 28px;
  font-size: 12.5px;
  background: #fff;
}

.segmented {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-pill);
  background: var(--surface-3);
}

.seg {
  height: 26px;
  padding: 0 16px;
  border-radius: var(--r-pill);
  font-size: 13px;
  color: var(--ink-3);
}

.seg.is-active {
  background: var(--brand);
  color: #fff;
  font-weight: 500;
}

.manage-grid {
  padding: 4px 0;
}

.footer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 10px 20px calc(14px + var(--safe-b));
  background: linear-gradient(180deg, rgba(244, 245, 247, 0) 0%, var(--page) 34%);
}
</style>
