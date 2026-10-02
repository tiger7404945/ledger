<script setup>
import { computed } from 'vue'
import IconBase from './icons/IconBase.vue'
import { CATEGORY_ICON_RATIO } from './icons/index.js'

const props = defineProps({
  icon: { type: String, default: 'more' },
  /** 圆形底色：muted 浅灰（宫格）/ mint 浅绿（列表）/ active 主题绿实底 */
  variant: { type: String, default: 'muted' },
  size: { type: Number, default: 44 },
  badge: { type: Boolean, default: false },
  /** 图标/圆底尺寸比，默认取全局可配参数（icons/index.js 的 CATEGORY_ICON_RATIO） */
  iconRatio: { type: Number, default: CATEGORY_ICON_RATIO }
})

const style = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`
}))
const iconSize = computed(() => Math.round(props.size * props.iconRatio))
const badgeSize = computed(() => Math.max(11, Math.round(props.size * 0.32)))
</script>

<template>
  <span class="cat-icon" :class="`is-${variant}`" :style="style">
    <IconBase :name="icon" :size="iconSize" :stroke-width="variant === 'active' ? 1.8 : 1.6" />
    <i v-if="badge" class="badge" :style="{ width: badgeSize + 'px', height: badgeSize + 'px' }" />
  </span>
</template>

<style scoped>
.cat-icon {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  flex: none;
  transition: background 0.16s ease, color 0.16s ease;
}

.is-muted {
  background: var(--surface-3);
  color: var(--ink);
}

.is-mint {
  background: var(--brand-soft);
  color: var(--ink);
}

.is-active {
  background: var(--brand);
  color: #fff;
  box-shadow: 0 4px 10px rgba(63, 217, 182, 0.35);
}

.badge {
  position: absolute;
  right: 1px;
  bottom: 3px;
  border-radius: 50%;
  background: #cbd2d4;
  border: 2px solid #fff;
  box-sizing: content-box;
}

.is-active .badge {
  border-color: var(--brand);
}
</style>
