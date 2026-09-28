<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useCategoryStore } from '@/stores/category.js'
import { useToast } from '@/composables/useToast.js'
import IconBase from '@/components/icons/IconBase.vue'
import CategoryIcon from '@/components/CategoryIcon.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const route = useRoute()
const router = useRouter()
const categoryStore = useCategoryStore()
const toast = useToast()

const parentId = computed(() => String(route.params.parentId || ''))
const parent = computed(() => categoryStore.byId[parentId.value] || null)
const children = computed(() => categoryStore.children(parentId.value))

const confirmOpen = ref(false)
const pendingDelete = ref(null)

const deleteTarget = computed(() =>
  pendingDelete.value ? categoryStore.byId[pendingDelete.value] : null
)

const deleteMessage = computed(() => {
  if (!pendingDelete.value) return ''
  if (pendingDelete.value === parentId.value) {
    return `将同时删除其下 ${children.value.length} 个二级分类，已记录的账单不会受影响。`
  }
  return '删除后该二级分类不再出现在记账页，已记录的账单不会受影响。'
})

function close() {
  router.back()
}

function editPrimary() {
  router.push({ path: '/category/edit', query: { id: parentId.value } })
}

function editChild(child) {
  router.push({ path: '/category/edit', query: { id: child.id } })
}

function askDelete(id) {
  pendingDelete.value = id
  confirmOpen.value = true
}

async function doDelete() {
  const id = pendingDelete.value
  pendingDelete.value = null
  if (!id) return
  try {
    await categoryStore.removeCategory(id, { cascade: id === parentId.value })
    toast.success('已删除')
    if (id === parentId.value) close()
  } catch (e) {
    toast.error(e?.message || '删除失败')
  }
}

function createSub() {
  router.push({
    path: '/category/edit',
    query: {
      scope: 'secondary',
      parentId: parentId.value,
      type: parent.value?.type || 'expense'
    }
  })
}
</script>

<template>
  <div class="sub-root">
    <div class="mask" @click="close" />
    <section class="sheet">
      <header class="sheet-head">
        <CategoryIcon :icon="parent?.icon || 'more'" variant="mint" :size="44" />
        <span class="parent-name">{{ parent?.name || '分类' }}</span>
        <div class="head-actions">
          <button class="ghost-btn" type="button" @click="editPrimary">
            <IconBase name="edit" :size="14" />
            编辑
          </button>
          <button class="ghost-btn" type="button" @click="askDelete(parentId)">
            <IconBase name="trash" :size="14" />
            删除
          </button>
        </div>
      </header>

      <div class="sheet-body">
        <div v-for="child in children" :key="child.id" class="sub-row">
          <CategoryIcon :icon="child.icon" variant="mint" :size="40" />
          <span class="sub-name">{{ parent?.name }}-{{ child.name }}</span>
          <button class="row-btn" type="button" @click="editChild(child)">
            <IconBase name="edit" :size="17" />
          </button>
          <button class="row-btn" type="button" @click="askDelete(child.id)">
            <IconBase name="trash" :size="17" />
          </button>
        </div>

        <p v-if="!children.length" class="empty">还没有二级分类，点击下方按钮创建</p>
      </div>

      <footer class="sheet-foot">
        <button class="btn-dark" type="button" @click="createSub">新建二级分类</button>
      </footer>
    </section>

    <ConfirmDialog
      v-model="confirmOpen"
      :title="`删除「${deleteTarget?.name || ''}」？`"
      :message="deleteMessage"
      confirm-text="删除"
      danger
      @confirm="doDelete"
    />
  </div>
</template>

<style scoped>
.sub-root {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 100%;
  max-width: var(--frame-w);
  z-index: 60;
  display: flex;
  align-items: flex-end;
}

.mask {
  position: absolute;
  inset: 0;
  background: rgba(20, 22, 26, 0.42);
}

.sheet {
  position: relative;
  width: 100%;
  max-height: 78%;
  display: flex;
  flex-direction: column;
  background: var(--page);
  border-top-left-radius: 20px;
  border-top-right-radius: 20px;
  box-shadow: var(--shadow-sheet);
  animation: sheet-in 0.24s cubic-bezier(0.22, 0.61, 0.36, 1);
}

@keyframes sheet-in {
  from {
    transform: translateY(100%);
  }
  to {
    transform: translateY(0);
  }
}

.sheet-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px 14px;
  border-bottom: 1px solid var(--hairline);
  background: var(--page);
  border-top-left-radius: 20px;
  border-top-right-radius: 20px;
}

.parent-name {
  flex: 1;
  font-size: 16px;
  font-weight: 500;
}

.head-actions {
  display: flex;
  gap: 8px;
}

.ghost-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 11px;
  border-radius: var(--r-pill);
  border: 1px solid var(--surface-4);
  background: #fff;
  color: var(--ink-2);
  font-size: 12.5px;
}

.ghost-btn:active {
  background: var(--surface-2);
}

.sheet-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 18px 8px;
  background: #fff;
}

.sub-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--hairline);
}

.sub-row:last-child {
  border-bottom: none;
}

.sub-name {
  flex: 1;
  font-size: 14.5px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  color: var(--ink-2);
}

.row-btn:active {
  color: var(--brand-700);
}

.empty {
  margin: 30px 0;
  text-align: center;
  font-size: 13px;
  color: var(--ink-4);
}

.sheet-foot {
  flex: none;
  padding: 10px 18px calc(16px + var(--safe-b));
  background: var(--page);
}
</style>
