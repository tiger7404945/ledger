<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useCategoryStore } from '@/stores/category.js'
import { NAME_MAX_LENGTH } from '@/api/contract.js'
import { useToast } from '@/composables/useToast.js'
import AppHeader from '@/components/AppHeader.vue'
import IconBase from '@/components/icons/IconBase.vue'
import { ICON_GROUPS } from '@/components/icons/index.js'

const route = useRoute()
const router = useRouter()
const categoryStore = useCategoryStore()
const toast = useToast()

const groups = ICON_GROUPS
const editId = ref(String(route.query.id || ''))
const scope = ref(route.query.scope === 'secondary' ? 'secondary' : 'primary')
const routeParentId = ref(String(route.query.parentId || ''))
const type = ref(route.query.type === 'income' ? 'income' : 'expense')

const name = ref('')
const icon = ref(groups[0].icons[0])
const loading = ref(false)
const saving = ref(false)

const editing = computed(() => !!editId.value)
const editedCategory = computed(() => (editId.value ? categoryStore.byId[editId.value] : null))

/** 实际归属的一级分类 id：新建二级用 query，编辑时用分类自身的 parentId */
const parentId = computed(() => {
  if (editing.value) return editedCategory.value?.parentId || ''
  return scope.value === 'secondary' ? routeParentId.value : ''
})

const parentCategory = computed(() => (parentId.value ? categoryStore.byId[parentId.value] : null))

const isSecondary = computed(() => !!parentCategory.value)

const title = computed(() => {
  if (editing.value) return '修改分类'
  return scope.value === 'secondary' ? '新建二级分类' : '新建一级分类'
})

const relatedHint = computed(() =>
  isSecondary.value ? `该二级分类属于${parentCategory.value.name}大类` : ''
)

/* ---------------- 图标选择器：左右联动 ---------------- */
const scrollRef = ref(null)
const groupRefs = ref({})
const activeGroup = ref(groups[0].key)

function setGroupRef(key, el) {
  if (el) groupRefs.value[key] = el
}

function onScroll() {
  const container = scrollRef.value
  if (!container) return
  const top = container.scrollTop + 24
  let current = groups[0].key
  groups.forEach((group) => {
    const el = groupRefs.value[group.key]
    if (el && el.offsetTop <= top) current = group.key
  })
  activeGroup.value = current
}

function scrollToGroup(key) {
  const el = groupRefs.value[key]
  if (!el || !scrollRef.value) return
  activeGroup.value = key
  scrollRef.value.scrollTo({ top: Math.max(el.offsetTop - 8, 0), behavior: 'smooth' })
}

function locateGroupOf(iconName) {
  return groups.find((group) => group.icons.includes(iconName))?.key || groups[0].key
}

/* ---------------- 保存 ---------------- */
async function save() {
  const value = name.value.trim()
  if (!value) {
    toast.error('请输入分类名称')
    return
  }
  if (value.length > NAME_MAX_LENGTH) {
    toast.error(`分类名称最多 ${NAME_MAX_LENGTH} 个字`)
    return
  }

  saving.value = true
  try {
    if (editing.value) {
      await categoryStore.updateCategory(editId.value, { name: value, icon: icon.value })
      toast.success('修改成功')
    } else {
      await categoryStore.createCategory({
        name: value,
        icon: icon.value,
        type: type.value,
        parentId: scope.value === 'secondary' ? routeParentId.value : null
      })
      toast.success(scope.value === 'secondary' ? '二级分类已创建' : '一级分类已创建')
    }
    router.back()
  } catch (e) {
    toast.error(e?.message || '保存失败')
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  await initFromRoute()
})

/** 同一路由下切换 query（如从「新建」跳到「修改」）时重新初始化 */
watch(
  () => route.fullPath,
  async () => {
    await initFromRoute()
  }
)

async function initFromRoute() {
  loading.value = true
  editId.value = String(route.query.id || '')
  scope.value = route.query.scope === 'secondary' ? 'secondary' : 'primary'
  routeParentId.value = String(route.query.parentId || '')
  type.value = route.query.type === 'income' ? 'income' : 'expense'
  name.value = ''
  icon.value = groups[0].icons[0]

  await categoryStore.ensureLoaded()

  if (editId.value) {
    const category = categoryStore.byId[editId.value]
    if (category) {
      name.value = category.name
      icon.value = category.icon
      type.value = category.type
    } else {
      toast.error('分类不存在')
    }
  }
  loading.value = false

  await nextTick()
  const key = locateGroupOf(icon.value)
  const container = scrollRef.value
  if (key !== groups[0].key) {
    scrollToGroup(key)
  } else if (container) {
    container.scrollTop = 0
    activeGroup.value = groups[0].key
  }
}
</script>

<template>
  <div class="page edit-page">
    <AppHeader :title="title" :back="true" />

    <div class="page-body">
      <div class="field-head">
        <span class="section-title">分类名称</span>
        <span v-if="relatedHint" class="field-hint">{{ relatedHint }}</span>
      </div>

      <div class="card input-card">
        <input
          v-model="name"
          type="text"
          class="name-input"
          :maxlength="NAME_MAX_LENGTH"
          placeholder="请输入分类名称"
        />
        <span class="counter">{{ name.length }}/{{ NAME_MAX_LENGTH }}</span>
      </div>

      <div class="field-head">
        <span class="section-title">分类图标</span>
      </div>

      <div class="card picker">
        <aside class="rail">
          <button
            v-for="group in groups"
            :key="group.key"
            class="rail-item"
            :class="{ 'is-active': activeGroup === group.key }"
            type="button"
            @click="scrollToGroup(group.key)"
          >
            {{ group.label }}
          </button>
        </aside>

        <div ref="scrollRef" class="icon-area" @scroll.passive="onScroll">
          <section
            v-for="group in groups"
            :key="group.key"
            :ref="(el) => setGroupRef(group.key, el)"
            class="icon-group"
          >
            <h4 class="group-title">{{ group.label }}</h4>
            <div class="icon-grid">
              <button
                v-for="key in group.icons"
                :key="key"
                class="icon-cell"
                type="button"
                @click="icon = key"
              >
                <span class="circle" :class="{ 'is-active': icon === key }">
                  <IconBase :name="key" :size="21" :stroke-width="icon === key ? 1.8 : 1.6" />
                </span>
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>

    <footer class="footer">
      <button class="btn-dark" type="button" :disabled="saving" @click="save">保存</button>
    </footer>
  </div>
</template>

<style scoped>
.edit-page {
  background: var(--page);
}

.page-body {
  padding: 0 16px 100px;
}

.field-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 4px 2px 10px;
}

.field-hint {
  font-size: 12px;
  color: var(--ink-3);
}

.input-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  height: 56px;
  margin-bottom: 18px;
}

.name-input {
  flex: 1;
  min-width: 0;
  font-size: 15.5px;
}

.counter {
  font-size: 12.5px;
  color: var(--ink-4);
  font-family: var(--font-num);
}

/* ---------- 图标选择器 ---------- */
.picker {
  display: flex;
  height: 58vh;
  min-height: 320px;
  overflow: hidden;
}

.rail {
  flex: none;
  width: 76px;
  padding: 10px 0;
  overflow-y: auto;
  scrollbar-width: none;
  border-right: 1px solid var(--hairline);
}

.rail::-webkit-scrollbar {
  display: none;
}

.rail-item {
  display: block;
  width: 100%;
  padding: 13px 0;
  font-size: 14px;
  color: var(--ink-4);
  text-align: center;
}

.rail-item.is-active {
  color: var(--ink);
  font-weight: 600;
  position: relative;
}

.rail-item.is-active::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 4px;
  transform: translateX(-50%);
  width: 34px;
  height: 2px;
  border-radius: 2px;
  background: var(--brand);
}

.icon-area {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 12px 8px 20px;
  scrollbar-width: none;
}

.icon-area::-webkit-scrollbar {
  display: none;
}

.group-title {
  margin: 8px 0 10px 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}

.icon-grid {
  display: flex;
  flex-wrap: wrap;
}

.icon-cell {
  width: 20%;
  display: flex;
  justify-content: center;
  padding-bottom: 14px;
}

.circle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--surface-3);
  color: var(--ink);
  transition: background 0.16s ease, color 0.16s ease;
}

.circle.is-active {
  background: var(--brand);
  color: #fff;
  box-shadow: 0 4px 10px rgba(63, 217, 182, 0.32);
}

.icon-cell:active .circle {
  opacity: 0.75;
}

/* ---------- 底部 ---------- */
.footer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 12px 20px calc(16px + var(--safe-b));
  background: linear-gradient(180deg, rgba(244, 245, 247, 0) 0%, var(--page) 40%);
}
</style>
