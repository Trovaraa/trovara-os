<script setup lang="ts">
import { RouterView } from 'vue-router'
import InstallPrompt from '@/components/InstallPrompt.vue'
import SwUpdateBanner from '@/components/SwUpdateBanner.vue'
</script>

<template>
  <RouterView />
  <InstallPrompt />
  <SwUpdateBanner />
</template>
