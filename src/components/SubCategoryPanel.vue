<script setup>
import { computed } from 'vue'
import CategoryIcon from './CategoryIcon.vue'
import IconBase from './icons/IconBase.vue'

const ADD_KEY = '__add__'

const props = defineProps({
  items: { type: Array, default: () => [] },
  selectedId: { type: String, default: '' },
  columns: { type: Number, default: 5 },
  iconSize: { type: Number, default: 44 }
})

const emit = defineEmits(['select', 'add'])

/** 二级分类按行切分，并在末尾追加「添加小类」占位 */
const rows = computed(() => {
  const out = []
  for (let i = 0; i < props.items.length; i += props.columns) {
    out.push(props.items.slice(i, i + props.columns))
  }
  if (!out.length) out.push([])
  const last = out[out.length - 1]
  if (last.length >= props.columns) out.push([{ id: ADD_KEY }])
  else last.push({ id: ADD_KEY })
  return out
})

function onCell(item) {
  if (item.id === ADD_KEY) emit('add')
  else emit('select', item)
}
</script>

<template>
  <div class="sub-panel">
    <div v-for="(row, rowIndex) in rows" :key="rowIndex" class="sub-row">
      <button
        v-for="item in row"
        :key="item.id"
        class="sub-cell"
        type="button"
        @click="onCell(item)"
      >
        <template v-if="item.id === ADD_KEY">
          <span class="add-circle" :style="{ width: iconSize + 'px', height: iconSize + 'px' }">
            <IconBase name="plus" :size="18" :stroke-width="1.6" />
          </span>
          <span class="sub-name">添加小类</span>
        </template>
        <template v-else>
          <CategoryIcon
            :icon="item.icon"
            :size="iconSize"
            :variant="item.id === selectedId ? 'active' : 'muted'"
          />
          <span class="sub-name">{{ item.name }}</span>
        </template>
      </button>
    </div>
  </div>
</template>

<style scoped>
.sub-panel {
  margin: 2px 4px 14px;
  padding: 14px 0 2px;
  background: #fff;
  border-radius: var(--r-md);
}

.sub-row {
  display: flex;
  width: 100%;
}

.sub-cell {
  flex: 0 0 calc(100% / v-bind(columns));
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding-bottom: 14px;
}

.sub-cell:active {
  opacity: 0.7;
}

.sub-name {
  font-size: 11px;
  line-height: 1.1;
  color: var(--ink);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.add-circle {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--surface-3);
  color: var(--ink-2);
}
</style>
