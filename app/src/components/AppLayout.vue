<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import LanguageSwitcher from '@/components/LanguageSwitcher.vue'
import { onlineStatus, pendingSyncCount, lastSyncedAt, syncStatus, retrySync } from '@/lib/offline-api'

const props = defineProps<{ workerMode?: boolean }>()

const auth = useAuthStore()
const route = useRoute()
const { t } = useI18n()
const menuOpen = ref(false)
const retrying = ref(false)

const isFieldWorker = computed(() => auth.user?.role === 'field_worker')

const links = computed(() => {
  const today = { to: '/today', labelKey: 'nav.today' as const }
  if (isFieldWorker.value) {
    return [today, { to: '/worker', labelKey: 'nav.myTasks' as const }]
  }
  const managerLinks = auth.canApprove
    ? [
        { to: '/templates', labelKey: 'nav.templates' as const },
        { to: '/zones', labelKey: 'nav.zones' as const },
        { to: '/events', labelKey: 'nav.events' as const },
        { to: '/ai', labelKey: 'nav.ai' as const },
      ]
    : []

  const ownerLinks = auth.isOwner
    ? [
        { to: '/users', labelKey: 'nav.users' as const },
        { to: '/tasks/post-approval', labelKey: 'nav.postApproval' as const },
        { to: '/settings', labelKey: 'nav.settings' as const },
        { to: '/finance', labelKey: 'nav.finance' as const },
        { to: '/traceability', labelKey: 'nav.traceability' as const },
        { to: '/reports', labelKey: 'nav.reports' as const },
      ]
    : []

  return [
    today,
    { to: '/dashboard', labelKey: 'nav.dashboard' as const },
    { to: '/tasks', labelKey: 'nav.tasks' as const },
    { to: '/inventory', labelKey: 'nav.inventory' as const },
    { to: '/crops', labelKey: 'nav.crops' as const },
    { to: '/livestock', labelKey: 'nav.livestock' as const },
    { to: '/sales', labelKey: 'nav.sales' as const },
    { to: '/whatsapp', labelKey: 'nav.whatsapp' as const },
    ...managerLinks,
    ...ownerLinks,
  ]
})

function closeMenu() {
  menuOpen.value = false
}

function isActive(path: string) {
  return route.path === path
}

function formatSyncTime(d: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  return d.toLocaleDateString()
}

async function handleRetry() {
  retrying.value = true
  try {
    await retrySync()
  } finally {
    retrying.value = false
  }
}
</script>

<template>
  <div class="min-h-screen w-full max-w-[100vw] overflow-x-hidden flex flex-col md:flex-row bg-slate-950">
    <!-- Mobile header -->
    <header class="md:hidden sticky top-0 z-40 flex items-center gap-2 px-3 py-3 bg-slate-900 border-b border-slate-800 min-w-0 max-w-full safe-area-x safe-area-pt">
      <button
        v-if="!isFieldWorker"
        type="button"
        class="min-h-[2.25rem] min-w-[2.25rem] flex items-center justify-center rounded-lg bg-slate-800 border border-slate-700 text-white shrink-0"
        :aria-label="t('nav.menu')"
        @click="menuOpen = !menuOpen"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <div class="min-w-0 flex-1">
        <p class="text-farm-gold text-[10px] font-bold tracking-widest uppercase truncate">{{ t('brand.name') }}</p>
        <h1 class="text-base font-black text-white truncate">{{ t('brand.farm') }}</h1>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <!-- Sync status pill -->
        <div
          v-if="!onlineStatus || pendingSyncCount > 0 || syncStatus === 'error'"
          class="flex items-center gap-1 rounded-lg border px-1.5 py-1 text-[10px] font-bold uppercase tracking-wide max-w-[5rem]"
          :class="{
            'border-amber-700/60 bg-amber-950/50 text-amber-300': !onlineStatus,
            'border-blue-700/60 bg-blue-950/50 text-blue-300': onlineStatus && pendingSyncCount > 0 && syncStatus !== 'error',
            'border-red-700/60 bg-red-950/50 text-red-300': syncStatus === 'error',
          }"
        >
          <span
            class="h-1.5 w-1.5 rounded-full shrink-0"
            :class="{
              'bg-amber-400': !onlineStatus,
              'bg-blue-400 animate-pulse': onlineStatus && syncStatus === 'syncing',
              'bg-blue-400': onlineStatus && syncStatus === 'idle' && pendingSyncCount > 0,
              'bg-red-400': syncStatus === 'error',
            }"
          />
          <span v-if="!onlineStatus" class="truncate">{{ t('offline.short') }}</span>
          <span v-else-if="syncStatus === 'error'" class="truncate">Err</span>
          <span v-else-if="pendingSyncCount > 0" class="tabular-nums">{{ pendingSyncCount }}</span>
        </div>
        <LanguageSwitcher compact />
      </div>
    </header>

    <!-- Mobile drawer -->
    <div
      v-if="menuOpen && !isFieldWorker"
      class="md:hidden fixed inset-0 z-50"
    >
      <div class="absolute inset-0 bg-black/60" @click="closeMenu" />
      <aside class="absolute left-0 top-0 bottom-0 w-72 bg-slate-900 border-r border-slate-800 p-6 flex flex-col">
        <div class="mb-6 flex items-center justify-between">
          <p class="text-farm-gold text-xs font-bold tracking-widest uppercase">{{ t('brand.name') }}</p>
          <button type="button" class="text-slate-400 hover:text-white p-2" :aria-label="t('common.close')" @click="closeMenu">
            ✕
          </button>
        </div>
        <nav class="space-y-1 flex-1 overflow-auto">
          <RouterLink
            v-for="link in links"
            :key="link.to"
            :to="link.to"
            class="block px-3 py-3 rounded-lg text-sm font-medium transition-colors"
            :class="isActive(link.to)
              ? 'bg-farm-green/20 text-farm-green'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'"
            @click="closeMenu"
          >
            {{ t(link.labelKey) }}
          </RouterLink>
        </nav>
        <div class="pt-4 border-t border-slate-800">
          <p class="text-sm font-semibold text-white">{{ auth.user?.name }}</p>
          <button
            class="mt-3 text-sm text-slate-400 hover:text-red-400 transition-colors min-h-[2.75rem]"
            @click="auth.logout()"
          >
            {{ t('common.signOut') }}
          </button>
        </div>
      </aside>
    </div>

    <!-- Desktop sidebar -->
    <aside class="hidden md:flex relative z-30 w-64 shrink-0 bg-slate-900 border-r border-slate-800 p-6 flex-col">
      <div class="mb-6 flex items-start justify-between gap-2">
        <div>
          <p class="text-farm-gold text-xs font-bold tracking-widest uppercase">{{ t('brand.name') }}</p>
          <h1 class="text-xl font-black text-white mt-1">{{ t('brand.farm') }}</h1>
        </div>
        <LanguageSwitcher />
      </div>

      <nav class="space-y-1 flex-1">
        <RouterLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          class="block px-3 py-2.5 rounded-lg text-sm font-medium transition-colors"
          :class="isActive(link.to)
            ? 'bg-farm-green/20 text-farm-green'
            : 'text-slate-400 hover:text-white hover:bg-slate-800'"
        >
          {{ t(link.labelKey) }}
        </RouterLink>
      </nav>

      <!-- Desktop sync status -->
      <div class="mt-4 mb-2">
        <div v-if="!onlineStatus" class="flex items-center gap-2 rounded-lg bg-amber-950/50 border border-amber-700/40 px-3 py-2">
          <span class="h-2 w-2 rounded-full bg-amber-400 shrink-0" />
          <p class="text-xs text-amber-300 font-medium">{{ t('offline.short') }} — changes queued</p>
        </div>
        <div v-else-if="syncStatus === 'error'" class="flex items-center justify-between gap-2 rounded-lg bg-red-950/50 border border-red-700/40 px-3 py-2">
          <div class="flex items-center gap-2">
            <span class="h-2 w-2 rounded-full bg-red-400 shrink-0" />
            <p class="text-xs text-red-300 font-medium">Sync failed</p>
          </div>
          <button
            type="button"
            class="text-xs text-red-300 hover:text-white underline"
            :disabled="retrying"
            @click="handleRetry"
          >
            {{ retrying ? '…' : 'Retry' }}
          </button>
        </div>
        <div v-else-if="pendingSyncCount > 0" class="flex items-center gap-2 rounded-lg bg-blue-950/50 border border-blue-700/40 px-3 py-2">
          <span class="h-2 w-2 rounded-full bg-blue-400 animate-pulse shrink-0" />
          <p class="text-xs text-blue-300 font-medium">{{ pendingSyncCount }} change(s) syncing</p>
        </div>
        <div v-else-if="lastSyncedAt" class="px-1">
          <p class="text-[10px] text-slate-600">Synced {{ formatSyncTime(lastSyncedAt) }}</p>
        </div>
      </div>

      <div class="pt-4 border-t border-slate-800">
        <p class="text-sm font-semibold text-white">{{ auth.user?.name }}</p>
        <p class="text-xs text-slate-500 capitalize">{{ auth.user?.role?.replace('_', ' ') }}</p>
        <button
          class="mt-3 text-xs text-slate-400 hover:text-red-400 transition-colors"
          @click="auth.logout()"
        >
          {{ t('common.signOut') }}
        </button>
      </div>
    </aside>

    <main
      class="flex-1 min-w-0 w-full max-w-full p-3 sm:p-4 md:p-8 overflow-x-hidden overflow-y-auto safe-area-x"
      :class="{ 'pb-[calc(5rem+env(safe-area-inset-bottom))]': isFieldWorker || workerMode }"
    >
      <div class="min-w-0 max-w-full break-words">
        <slot />
      </div>
    </main>

    <!-- Mobile bottom nav for field workers -->
    <nav
      v-if="isFieldWorker"
      class="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-slate-900/95 backdrop-blur border-t border-slate-800 safe-area-pb"
    >
      <div class="grid grid-cols-2">
        <RouterLink
          to="/today"
          class="flex flex-col items-center justify-center min-h-[4rem] gap-1 text-xs font-semibold transition-colors"
          :class="isActive('/today') ? 'text-farm-green' : 'text-slate-400'"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {{ t('nav.today') }}
        </RouterLink>
        <RouterLink
          to="/worker"
          class="flex flex-col items-center justify-center min-h-[4rem] gap-1 text-xs font-semibold transition-colors"
          :class="isActive('/worker') ? 'text-farm-green' : 'text-slate-400'"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
          {{ t('nav.myTasks') }}
        </RouterLink>
      </div>
    </nav>
  </div>
</template>

<style scoped>
.safe-area-pb {
  padding-bottom: env(safe-area-inset-bottom, 0);
}

.safe-area-x {
  padding-left: max(0.75rem, env(safe-area-inset-left));
  padding-right: max(0.75rem, env(safe-area-inset-right));
}

.safe-area-pt {
  padding-top: max(0.75rem, env(safe-area-inset-top));
}
</style>
