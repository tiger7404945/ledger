<script setup>
import { useRouter } from 'vue-router'
import IconBase from './icons/IconBase.vue'

const props = defineProps({
  title: { type: String, default: '' },
  back: { type: Boolean, default: false },
  backTo: { type: [String, Object], default: null },
  transparent: { type: Boolean, default: false }
})

const router = useRouter()

function goBack() {
  if (props.backTo) router.push(props.backTo)
  else router.back()
}
</script>

<template>
  <header class="app-header" :class="{ transparent }">
    <div class="side left">
      <slot name="left">
        <button v-if="back" class="icon-btn" aria-label="返回" @click="goBack">
          <IconBase name="back" :size="22" />
        </button>
      </slot>
    </div>
    <div class="center">
      <slot>{{ title }}</slot>
    </div>
    <div class="side right">
      <slot name="right" />
    </div>
  </header>
</template>

<style scoped>
.app-header {
  position: relative;
  display: flex;
  align-items: center;
  height: var(--nav-h);
  padding: 0 8px;
  flex: none;
  background: var(--page);
  z-index: 10;
}

.app-header.transparent {
  background: transparent;
}

.side {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 68px;
  height: 100%;
}

.right {
  justify-content: flex-end;
  margin-left: auto;
}

.center {
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 100%;
  pointer-events: none;
  font-size: 17px;
  font-weight: 500;
  color: var(--ink);
}

.center :deep(*) {
  pointer-events: auto;
}

.icon-btn {
  color: var(--ink);
}
</style>
