<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    titleId: string
    closeLabel: string
    variant?: 'modal' | 'drawer' | 'editor'
    closeOnBackdrop?: boolean
  }>(),
  { variant: 'modal', closeOnBackdrop: true },
)

const emit = defineEmits<{ close: [] }>()
const panel = ref<HTMLElement | null>(null)
let restoreFocus: HTMLElement | null = null
let background: HTMLElement | null = null
let backgroundWasInert = false
let scrollPositions: { element: HTMLElement; top: number; left: number }[] = []

const focusableSelector =
  'a[href],button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),summary,[contenteditable="true"],[tabindex]:not([tabindex="-1"])'

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
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function restoreContext() {
  if (!background) return
  background.inert = backgroundWasInert
  if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true })
  for (const { element, top, left } of scrollPositions) {
    element.scrollTop = top
    element.scrollLeft = left
  }
  background = null
  restoreFocus = null
  scrollPositions = []
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      background = document.querySelector<HTMLElement>('#app')
      backgroundWasInert = background?.inert ?? false
      scrollPositions = [...(background?.querySelectorAll<HTMLElement>('*') ?? []), document.documentElement]
        .filter(element => element.scrollTop !== 0 || element.scrollLeft !== 0)
        .map(element => ({ element, top: element.scrollTop, left: element.scrollLeft }))
      if (background) background.inert = true
      await nextTick()
      if (!props.open) return
      const initial = panel.value?.querySelector<HTMLElement>('[autofocus]:not(:disabled)') ??
        [...(panel.value?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])]
          .find(element => !element.hidden && element.getClientRects().length > 0)
      ;(initial ?? panel.value)?.focus({ preventScroll: true })
    } else {
      restoreContext()
    }
  },
  { immediate: true },
)

onBeforeUnmount(restoreContext)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[1000] flex bg-black/70"
      :class="variant === 'editor' ? 'justify-end' : variant === 'drawer' ? 'justify-start' : 'items-center justify-center p-4'"
      @mousedown.self="closeOnBackdrop && close()"
      @wheel.self.prevent
      @touchmove.self.prevent
    >
      <section
        ref="panel"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :class="
          variant === 'editor'
            ? 'h-dvh w-full max-w-4xl overflow-y-auto overscroll-contain bg-[var(--os-shell)] text-[var(--os-fg)] shadow-2xl'
            : variant === 'drawer'
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
