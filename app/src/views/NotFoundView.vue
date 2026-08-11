<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { useAuthStore } from '@/stores/auth'
import { defaultHome } from '@/lib/navigation'

const router = useRouter()
const auth = useAuthStore()
const { t } = useI18n()
</script>

<template>
  <AppLayout v-if="auth.isAuthenticated">
    <section class="mx-auto max-w-xl py-16 text-center">
      <p class="text-sm font-bold uppercase tracking-widest text-farm-green">404</p>
      <h1 class="mt-2 text-3xl font-black text-os-fg">{{ t('notFound.title') }}</h1>
      <p class="mt-3 text-slate-400">{{ t('notFound.message') }}</p>
      <div class="mt-6 flex justify-center gap-3">
        <button class="rounded-xl border border-slate-700 px-4 py-2 text-slate-300" @click="router.back()">
          {{ t('notFound.back') }}
        </button>
        <button class="rounded-xl bg-farm-green px-4 py-2 font-bold text-white" @click="router.push(defaultHome(auth.user?.role))">
          {{ t('notFound.home') }}
        </button>
      </div>
    </section>
  </AppLayout>
  <main v-else class="grid min-h-dvh place-items-center bg-[var(--os-canvas)] p-6 text-center">
    <section>
      <p class="text-sm font-bold uppercase tracking-widest text-farm-green">404</p>
      <h1 class="mt-2 text-3xl font-black text-os-fg">{{ t('notFound.title') }}</h1>
      <button class="mt-6 rounded-xl bg-farm-green px-4 py-2 font-bold text-white" @click="router.push('/login')">
        {{ t('notFound.signIn') }}
      </button>
    </section>
  </main>
</template>
