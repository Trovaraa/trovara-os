<script setup lang="ts">
withDefaults(defineProps<{
  descriptor?: string
  compact?: boolean
}>(), {
  descriptor: 'OS',
  compact: false,
})
</script>

<template>
  <span
    class="inline-flex items-center"
    :class="compact ? 'gap-0' : 'gap-2.5'"
    aria-label="Trovara"
  >
    <img
      src="/brand/trovara-monogram-tile-v1.svg"
      alt=""
      :class="compact ? 'h-8 w-8' : 'h-11 w-11'"
      width="44"
      height="44"
    />
    <span v-if="!compact" class="flex flex-col leading-none">
      <span class="text-base font-black tracking-[0.06em] text-white">TROVARA</span>
      <span class="mt-1 text-[8px] font-black uppercase tracking-[0.3em] text-farm-gold">{{ descriptor }}</span>
    </span>
  </span>
</template>
