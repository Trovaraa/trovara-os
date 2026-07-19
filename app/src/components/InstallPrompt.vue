<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useInstallPrompt } from '@/lib/useInstallPrompt'

const { t } = useI18n()
const { visible, canPrompt, iosHint, install, dismiss } = useInstallPrompt()
</script>

<template>
  <Transition name="a2hs">
    <div
      v-if="visible"
      class="fixed bottom-20 md:bottom-6 left-4 right-4 md:left-auto md:right-6 md:max-w-sm z-[60] rounded-xl bg-slate-900 text-white shadow-2xl border border-slate-700 p-4"
      role="dialog"
      :aria-label="t('pwa.installTitle')"
    >
      <div class="flex gap-3 items-start">
        <div
          class="w-11 h-11 rounded-xl bg-[#1f6b42] flex items-center justify-center flex-shrink-0 font-black text-amber-300 text-lg"
        >
          T
        </div>
        <div class="flex-1 min-w-0">
          <p class="font-semibold text-sm mb-1">{{ t('pwa.installTitle') }}</p>
          <p v-if="canPrompt" class="text-slate-300 text-xs leading-relaxed mb-3">
            {{ t('pwa.installBody') }}
          </p>
          <p v-else-if="iosHint" class="text-slate-300 text-xs leading-relaxed mb-3">
            {{ t('pwa.installIos') }}
          </p>
          <div class="flex flex-wrap gap-2">
            <button
              v-if="canPrompt"
              type="button"
              class="text-xs px-4 py-2 rounded-lg bg-[#1f6b42] text-white font-semibold hover:bg-[#185534] transition"
              @click="install"
            >
              {{ t('pwa.installAction') }}
            </button>
            <button
              type="button"
              class="text-xs px-3 py-2 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-800 transition"
              @click="dismiss"
            >
              {{ t('pwa.installDismiss') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.a2hs-enter-active,
.a2hs-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.a2hs-enter-from,
.a2hs-leave-to {
  opacity: 0;
  transform: translateY(12px);
}
</style>
