<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const farmName = defineModel<string>('farmName', { required: true })
const farmLocation = defineModel<string>('farmLocation', { required: true })
const farmLatitude = defineModel<string>('farmLatitude', { required: true })
const farmLongitude = defineModel<string>('farmLongitude', { required: true })
const farmTimezone = defineModel<string>('farmTimezone', { required: true })

defineProps<{
  savingFarm: boolean
  farmMessage: string | null
}>()

const emit = defineEmits<{ save: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
    <div>
      <h3 class="font-bold text-white">{{ t('settings.farmLocationTitle') }}</h3>
      <p class="text-xs text-slate-400 mt-0.5">{{ t('settings.farmLocationSubtitle') }}</p>
    </div>
    <div class="grid sm:grid-cols-2 gap-3">
      <input
        v-model="farmName"
        type="text"
        :placeholder="t('settings.farmName')"
        class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
      />
      <input
        v-model="farmLocation"
        type="text"
        :placeholder="t('settings.farmLocationLabel')"
        class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
      />
      <input
        v-model="farmLatitude"
        type="text"
        inputmode="decimal"
        :placeholder="t('settings.farmLatitude')"
        class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono"
      />
      <input
        v-model="farmLongitude"
        type="text"
        inputmode="decimal"
        :placeholder="t('settings.farmLongitude')"
        class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono"
      />
      <input
        v-model="farmTimezone"
        type="text"
        :placeholder="t('settings.farmTimezone')"
        class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white sm:col-span-2"
      />
    </div>
    <div class="flex items-center gap-3">
      <button
        type="button"
        :disabled="savingFarm || !farmName.trim() || !farmLocation.trim()"
        class="text-xs font-bold px-3 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
        @click="emit('save')"
      >
        {{ savingFarm ? t('settings.saving') : t('settings.saveFarmLocation') }}
      </button>
      <p v-if="farmMessage" class="text-xs text-slate-400">{{ farmMessage }}</p>
    </div>
  </div>
</template>
