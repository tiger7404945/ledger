<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useBillStore } from '@/stores/bill.js'
import IconBase from './icons/IconBase.vue'
import BillRow from './BillRow.vue'
import { formatDateDots } from '@/utils/date.js'

const open = defineModel('modelValue', { type: Boolean, default: false })

const store = useBillStore()
const router = useRouter()
const keyword = ref('')
const inputRef = ref(null)
let timer = null

watch(open, async (value) => {
  if (value) {
    keyword.value = ''
    await store.ensureLoaded()
    await nextTick()
    inputRef.value?.focus()
  } else {
    store.clearSearch()
  }
})

watch(keyword, (value) => {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => store.search(value), 160)
})

const grouped = computed(() => {
  const map = new Map()
  store.searchResults.forEach((bill) => {
    if (!map.has(bill.date)) map.set(bill.date, [])
    map.get(bill.date).push(bill)
  })
  return Array.from(map.entries()).map(([date, items]) => ({ date, items }))
})

const total = computed(() =>
  store.searchResults
    .filter((b) => b.type === 'expense')
    .reduce((sum, b) => sum + b.amount, 0)
)

function pick(bill) {
  open.value = false
  router.push({ path: '/record', query: { id: bill.id } })
}
</script>

<template>
  <Teleport to="body">
    <transition name="fade" appear>
      <div v-if="open" class="search-root">
        <header class="bar">
          <div class="field">
            <IconBase name="search" :size="18" />
            <input
              ref="inputRef"
              v-model="keyword"
              type="search"
              placeholder="搜索备注、分类或金额"
            />
            <button v-if="keyword" class="clear" type="button" @click="keyword = ''">
              <IconBase name="close" :size="14" :stroke-width="2" />
            </button>
          </div>
          <button class="cancel" type="button" @click="open = false">取消</button>
        </header>

        <div class="body">
          <p v-if="!keyword" class="hint">输入备注、分类名或金额关键词</p>
          <p v-else-if="!store.searchResults.length && !store.searching" class="hint">
            没有找到相关账单
          </p>
          <template v-else>
            <p class="summary">
              共 {{ store.searchResults.length }} 条 · 支出 ¥{{ total.toFixed(2) }}
            </p>
            <section v-for="group in grouped" :key="group.date" class="card group">
              <header class="group-head">
                <span>{{ formatDateDots(group.date) }}</span>
              </header>
              <BillRow
                v-for="bill in group.items"
                :key="bill.id"
                :bill="bill"
                :size="38"
                @click="pick"
              />
            </section>
          </template>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.search-root {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 100%;
  max-width: var(--frame-w);
  z-index: 80;
  display: flex;
  flex-direction: column;
  background: var(--page);
}

.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--page);
}

.field {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 12px;
  border-radius: var(--r-pill);
  background: #fff;
  color: var(--ink-3);
}

.field input {
  flex: 1;
  min-width: 0;
  font-size: 14.5px;
  color: var(--ink);
  appearance: none;
}

.field input::-webkit-search-cancel-button {
  display: none;
}

.clear {
  display: flex;
  color: var(--ink-3);
}

.cancel {
  flex: none;
  font-size: 15px;
  color: var(--ink-2);
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 14px 30px;
}

.hint {
  margin: 40px 0 0;
  text-align: center;
  font-size: 13.5px;
  color: var(--ink-3);
}

.summary {
  margin: 6px 4px 10px;
  font-size: 12.5px;
  color: var(--ink-3);
}

.group {
  padding: 4px 16px 8px;
  margin-bottom: 12px;
}

.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0 4px;
  font-size: 13px;
  color: var(--ink-2);
}
</style>
