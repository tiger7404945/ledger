<script setup>
import ToastHost from '@/components/ToastHost.vue'
</script>

<template>
  <div class="app-frame">
    <router-view v-slot="{ Component }">
      <component :is="Component" />
    </router-view>
    <ToastHost />
  </div>
</template>
