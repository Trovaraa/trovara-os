<script setup lang="ts">
defineProps<{
  label: string
}>()
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-3 py-6" role="status" aria-live="polite">
    <div class="weather-tips-track" aria-hidden="true">
      <img class="weather-tips-mark" src="/brand/trovara-monogram-tile-v1.svg" alt="" />
    </div>
    <p class="text-sm text-slate-400">{{ label }}</p>
  </div>
</template>

<style scoped>
.weather-tips-track {
  position: relative;
  width: 7rem;
  height: 2.5rem;
  overflow: hidden;
}

.weather-tips-mark {
  position: absolute;
  top: 0.15rem;
  left: 0;
  width: 2rem;
  height: 2rem;
  animation: travel-mark 1.4s ease-in-out infinite;
}

@keyframes travel-mark {
  0% {
    transform: translateX(-0.5rem);
    opacity: 0;
  }
  20%, 80% {
    opacity: 1;
  }
  100% {
    transform: translateX(5.5rem);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .weather-tips-mark {
    animation: none;
    left: 2.25rem;
  }
}
</style>
