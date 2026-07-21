<script setup lang="ts">
defineProps<{
  label: string
}>()
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-3 py-6" role="status" aria-live="polite">
    <div class="weather-tips-track" aria-hidden="true">
      <span class="weather-tips-coconut">🥥</span>
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

.weather-tips-coconut {
  position: absolute;
  top: 0.15rem;
  left: 0;
  font-size: 1.75rem;
  line-height: 1;
  animation: roll-coconut 1.4s linear infinite;
}

@keyframes roll-coconut {
  0% {
    transform: translateX(-0.5rem) rotate(0deg);
  }
  100% {
    transform: translateX(5.5rem) rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .weather-tips-coconut {
    animation: none;
    left: 2.25rem;
  }
}
</style>
