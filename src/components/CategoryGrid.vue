<script setup>
import { computed } from 'vue'
import CategoryIcon from './CategoryIcon.vue'

const props = defineProps({
  items: { type: Array, default: () => [] },
  selectedId: { type: String, default: '' },
  /** 需要显示「含二级分类」角标的一级分类 id */
  badges: { type: Array, default: () => [] },
  columns: { type: Number, default: 5 },
  iconSize: { type: Number, default: 44 },
  /** 在该项所在行之后插入 #insert 插槽内容（记账页二级分类面板） */
  insertAfterId: { type: String, default: '' }
})

const emit = defineEmits(['select'])

const rows = computed(() => {
  const out = []
  for (let i = 0; i < props.items.length; i += props.columns) {
    out.push(props.items.slice(i, i + props.columns))
  }
  return out
})

const insertRowIndex = computed(() => {
  if (!props.insertAfterId) return -1
  return rows.value.findIndex((row) => row.some((item) => item.id === props.insertAfterId))
})
</script>

<template>
  <div class="cat-grid">
    <template v-for="(row, rowIndex) in rows" :key="rowIndex">
      <div class="cat-row">
        <button
          v-for="item in row"
          :key="item.id"
          class="cat-cell"
          type="button"
          @click="emit('select', item)"
        >
          <CategoryIcon
            :icon="item.icon"
            :size="iconSize"
            :variant="item.id === selectedId ? 'active' : 'muted'"
            :badge="badges.includes(item.id)"
          />
          <span class="cat-name">{{ item.name }}</span>
        </button>
      </div>
      <div v-if="rowIndex === insertRowIndex" class="cat-insert">
        <slot name="insert" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.cat-grid {
  width: 100%;
}

.cat-row {
  display: flex;
  width: 100%;
}

.cat-cell {
  /* 固定 1/columns 宽，最后一行不满时靠左，与参考图一致 */
  flex: 0 0 calc(100% / v-bind(columns));
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding-bottom: 16px;
}

.cat-cell:active {
  opacity: 0.7;
}

.cat-name {
  font-size: 11px;
  line-height: 1.1;
  color: var(--ink);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cat-insert {
  width: 100%;
}
</style>
