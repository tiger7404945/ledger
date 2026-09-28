<script setup>
import { computed } from 'vue'
import { getIconPath } from './index.js'

const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 22 },
  strokeWidth: { type: [Number, String], default: 1.6 }
})

const path = computed(() => getIconPath(props.name))
const px = computed(() => (typeof props.size === 'number' ? `${props.size}px` : props.size))
</script>

<template>
  <svg
    class="ui-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    :style="{ width: px, height: px }"
    v-html="path"
  />
</template>

<style scoped>
.ui-icon {
  display: block;
  flex: none;
  overflow: visible;
}
</style>
