<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{
  totpStatus: { enabled: boolean; hasSecret: boolean } | null
  totpSetup: { secret: string; otpAuthUrl: string; qrUrl: string } | null
  totpLoading: boolean
  totpMessage: string | null
}>()

const totpCode = defineModel<string>('totpCode', { required: true })
const totpDisablePassword = defineModel<string>('totpDisablePassword', { required: true })

const emit = defineEmits<{
  setup: []
  enable: []
  disable: []
}>()

const { t } = useI18n()
</script>

<template>
  <div class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
    <h3 class="font-bold text-white text-sm">{{ t('settings.founderSecurity') }}</h3>
    <div class="flex items-center gap-3">
      <span
        class="text-xs font-bold px-2.5 py-1 rounded-full"
        :class="totpStatus?.enabled ? 'bg-farm-green/20 text-farm-green' : 'bg-slate-700 text-slate-400'"
      >
        {{ totpStatus?.enabled ? t('settings.twoFaEnabled') : t('settings.twoFaDisabled') }}
      </span>
      <button
        type="button"
        class="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-50"
        :disabled="totpLoading"
        @click="emit('setup')"
      >
        {{
          totpLoading
            ? t('settings.preparing')
            : totpStatus?.enabled
              ? t('settings.rotateSecret')
              : t('settings.setupAuthenticator')
        }}
      </button>
    </div>

    <div v-if="totpSetup" class="rounded-xl border border-slate-700 bg-slate-950/50 p-4">
      <p class="text-xs text-slate-400">{{ t('settings.scanQr') }}</p>
      <img
        :src="totpSetup.qrUrl"
        alt="TOTP QR code"
        class="mt-3 h-40 w-40 rounded-lg border border-slate-700 bg-white p-1"
      />
      <p class="mt-2 text-[11px] text-slate-500 break-all">
        {{ t('settings.secretLabel') }} <span class="font-mono">{{ totpSetup.secret }}</span>
      </p>
      <a
        :href="totpSetup.otpAuthUrl"
        class="mt-1 inline-flex text-[11px] text-farm-green hover:underline break-all"
      >
        {{ t('settings.openOtpauth') }}
      </a>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <input
        v-model="totpCode"
        type="text"
        inputmode="numeric"
        maxlength="6"
        placeholder="123456"
        class="w-36 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm tracking-[0.2em] text-center text-white"
      />
      <button
        type="button"
        class="text-xs font-bold px-3 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
        :disabled="totpLoading || !totpSetup"
        @click="emit('enable')"
      >
        {{ t('settings.enable2fa') }}
      </button>
      <input
        v-model="totpDisablePassword"
        type="password"
        :placeholder="t('settings.disable2faPassword')"
        class="w-full max-w-xs bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
      />
      <button
        type="button"
        class="text-xs font-bold px-3 py-2 rounded-lg bg-red-900/40 text-red-300 hover:bg-red-900/60 disabled:opacity-50"
        :disabled="totpLoading || !totpStatus?.enabled"
        @click="emit('disable')"
      >
        {{ t('settings.disable2fa') }}
      </button>
    </div>
    <p v-if="totpMessage" class="text-xs text-slate-400">{{ totpMessage }}</p>
  </div>
</template>
