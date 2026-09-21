<script setup lang="ts">
import { ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AccessibleDialog from './AccessibleDialog.vue'

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  busy?: boolean
  dirty?: boolean
  trackChanges?: boolean
  resetKey?: string | number
}>(), { trackChanges: true })
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const titleId = `editor-${useId()}`
const changed = ref(false)
watch(() => [props.open, props.resetKey], () => { changed.value = false })
function requestClose() {
  if (props.busy) return
  if ((props.dirty || changed.value) && !window.confirm(t('editor.discard'))) return
  emit('close')
}
function markChanged() { if (props.trackChanges) changed.value = true }
defineExpose({ requestClose })
</script>

<template>
  <AccessibleDialog :open="open" :title-id="titleId" :close-label="t('editor.close')" variant="editor" :close-on-backdrop="false" @close="requestClose">
    <header class="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-[color:var(--os-border)] bg-[var(--os-shell)] px-4 py-3 sm:px-6">
      <h2 :id="titleId" class="min-w-0 break-words text-lg font-bold">{{ title }}</h2>
      <button type="button" class="min-h-11 shrink-0 rounded-xl border border-[color:var(--os-border)] px-4 py-2 font-semibold disabled:opacity-50" :disabled="busy" @click="requestClose">{{ t('editor.close') }}</button>
    </header>
    <fieldset :disabled="busy" class="min-w-0 p-4 sm:p-6" @input="markChanged" @change="markChanged"><slot /></fieldset>
  </AccessibleDialog>
</template>
