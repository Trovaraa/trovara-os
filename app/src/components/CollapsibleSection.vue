<script setup lang="ts">
import { ref, useId, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    title: string
    description?: string
    defaultOpen?: boolean
    open?: boolean
    contentClass?: string
    testId?: string
  }>(),
  {
    description: '',
    defaultOpen: true,
    open: undefined,
    contentClass: 'p-4 sm:p-5',
    testId: undefined,
  },
)

const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const contentId = `collapsible-${useId()}`
const expanded = ref(props.open ?? props.defaultOpen)

watch(
  () => props.open,
  (value) => {
    if (value !== undefined) expanded.value = value
  },
)

function toggle() {
  expanded.value = !expanded.value
  emit('update:open', expanded.value)
}
</script>

<template>
  <section
    class="overflow-hidden rounded-xl border border-slate-800 bg-slate-900"
    :data-testid="testId"
  >
    <button
      type="button"
      class="flex min-h-14 w-full items-start justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-slate-800/45 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-farm-green sm:px-5"
      :aria-expanded="expanded"
      :aria-controls="contentId"
      @click="toggle"
    >
      <span class="min-w-0">
        <span class="block text-sm font-bold text-white">{{ title }}</span>
        <span v-if="description" class="mt-1 block text-xs leading-5 text-slate-500">
          {{ description }}
        </span>
      </span>
      <span class="flex shrink-0 items-center gap-3">
        <slot name="meta" :expanded="expanded" />
        <svg
          class="mt-0.5 h-5 w-5 text-slate-400 transition-transform duration-200"
          :class="{ 'rotate-180': expanded }"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6" />
        </svg>
      </span>
    </button>

    <div v-show="expanded" :id="contentId" class="border-t border-slate-800">
      <div :class="contentClass">
        <slot />
      </div>
    </div>
  </section>
</template>
