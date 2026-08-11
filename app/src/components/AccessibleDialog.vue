<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    titleId: string
    closeLabel: string
    variant?: 'modal' | 'drawer'
    closeOnBackdrop?: boolean
  }>(),
  { variant: 'modal', closeOnBackdrop: true },
)

const emit = defineEmits<{ close: [] }>()
const panel = ref<HTMLElement | null>(null)
let restoreFocus: HTMLElement | null = null

const focusableSelector =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

function close() {
  emit('close')
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab' || !panel.value) return
  const focusable = [...panel.value.querySelectorAll<HTMLElement>(focusableSelector)].filter(
    (element) => !element.hidden && element.getClientRects().length > 0,
  )
  if (!focusable.length) {
    event.preventDefault()
    panel.value.focus()
    return
  }
  const first = focusable[0]
  const last = focusable.at(-1)!
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function setBackgroundInert(inert: boolean) {
  const app = document.querySelector<HTMLElement>('#app')
  if (app) app.inert = inert
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setBackgroundInert(true)
      await nextTick()
      const initial = panel.value?.querySelector<HTMLElement>('[autofocus], input, textarea, button')
      ;(initial ?? panel.value)?.focus()
    } else {
      setBackgroundInert(false)
      restoreFocus?.focus()
      restoreFocus = null
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  setBackgroundInert(false)
  restoreFocus?.focus()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[1000] flex bg-black/70"
      :class="variant === 'drawer' ? 'justify-start' : 'items-center justify-center p-4'"
      @mousedown.self="closeOnBackdrop && close()"
    >
      <section
        ref="panel"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :class="
          variant === 'drawer'
            ? 'h-full w-72 max-w-[90vw] overflow-auto bg-[var(--os-shell)] shadow-2xl'
            : 'max-h-[90dvh] w-full overflow-auto rounded-2xl border border-[color:var(--os-border)] bg-[var(--os-shell)] shadow-2xl'
        "
        tabindex="-1"
        @keydown="onKeydown"
      >
        <slot />
      </section>
    </div>
  </Teleport>
</template>
