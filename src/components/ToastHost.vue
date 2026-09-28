<script setup>
import { toasts } from '@/composables/useToast.js'
</script>

<template>
  <Teleport to="body">
    <div class="toast-host">
      <transition-group name="toast">
        <div v-for="item in toasts" :key="item.id" class="toast" :class="`is-${item.type}`">
          {{ item.message }}
        </div>
      </transition-group>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-host {
  position: fixed;
  bottom: 96px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 200;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
  width: max-content;
  max-width: 80vw;
}

.toast {
  padding: 9px 16px;
  border-radius: 10px;
  background: rgba(16, 18, 22, 0.86);
  color: #fff;
  font-size: 13.5px;
  line-height: 1.4;
  text-align: center;
  backdrop-filter: blur(4px);
}

.toast.is-success {
  background: rgba(23, 184, 148, 0.94);
}

.toast.is-error {
  background: rgba(226, 86, 74, 0.94);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
