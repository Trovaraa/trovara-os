<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import LanguageSwitcher from '@/components/LanguageSwitcher.vue'
import { roleLabel } from '@/lib/roles'
import { onlineStatus, pendingSyncCount, lastSyncedAt, syncStatus, retrySync } from '@/lib/offline-api'

const props = defineProps<{ workerMode?: boolean }>()

const auth = useAuthStore()
const route = useRoute()
const { t } = useI18n()
const menuOpen = ref(false)
const retrying = ref(false)
const mainEl = ref<HTMLElement | null>(null)

// The window is the scroll container (see router scrollBehavior). This only resets
// the inner <main> for any view that constrains its own height - the router owns
// window scroll so back/forward saved positions are respected.
onMounted(() => {
  mainEl.value?.scrollTo({ top: 0 })
  initExpandedGroups()
})

const isFieldWorker = computed(() => auth.user?.role === 'field_worker')

type NavItem = { to: string; labelKey: string; ownerOnly?: boolean }
type NavGroup = { titleKey: string | null; items: NavItem[] }

// Grouped sidebar. Field workers keep their flat two-item nav; everyone else
// (supervisor/owner) sees labelled sections. `ownerOnly` items are hidden from
// supervisors; the rest are visible to any non-worker (matches prior gating).
const navGroups = computed<NavGroup[]>(() => {
  if (isFieldWorker.value) {
    return [
      {
        titleKey: null,
        items: [
          { to: '/today', labelKey: 'nav.today' },
          { to: '/worker', labelKey: 'nav.myTasks' },
        ],
      },
    ]
  }

  const groups: NavGroup[] = [
    {
      titleKey: 'nav.grpOverview',
      items: [
        { to: '/today', labelKey: 'nav.today' },
        { to: '/dashboard', labelKey: 'nav.dashboard' },
      ],
    },
    {
      titleKey: 'nav.grpOperations',
      items: [
        { to: '/tasks', labelKey: 'nav.tasks' },
        { to: '/crops', labelKey: 'nav.crops' },
        { to: '/livestock', labelKey: 'nav.livestock' },
        { to: '/inventory', labelKey: 'nav.inventory' },
        { to: '/assets', labelKey: 'nav.assets' },
      ],
    },
    {
      titleKey: 'nav.grpSales',
      items: [
        { to: '/sales', labelKey: 'nav.sales' },
        { to: '/products', labelKey: 'nav.products', ownerOnly: true },
        { to: '/customer-insights', labelKey: 'nav.customerInsights', ownerOnly: true },
        { to: '/whatsapp', labelKey: 'nav.whatsapp' },
      ],
    },
    {
      titleKey: 'nav.grpInsights',
      items: [
        { to: '/traceability', labelKey: 'nav.traceability' },
        { to: '/events', labelKey: 'nav.events' },
        { to: '/ai', labelKey: 'nav.ai' },
        { to: '/reports', labelKey: 'nav.reports', ownerOnly: true },
        { to: '/finance', labelKey: 'nav.finance', ownerOnly: true },
      ],
    },
    {
      titleKey: 'nav.grpSetup',
      items: [
        { to: '/templates', labelKey: 'nav.templates' },
        { to: '/zones', labelKey: 'nav.zones' },
        { to: '/users', labelKey: 'nav.users', ownerOnly: true },
        { to: '/tasks/post-approval', labelKey: 'nav.postApproval', ownerOnly: true },
        { to: '/settings', labelKey: 'nav.settings', ownerOnly: true },
      ],
    },
  ]

  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => auth.isOwner || !i.ownerOnly) }))
    .filter((g) => g.items.length > 0)
})

// Collapsible sidebar sections. Minimized by default; the section holding the
// current route opens on first load, and manual toggles are remembered.
const NAV_STORAGE_KEY = 'trovara_nav_expanded'
const expandedGroups = ref<Set<string>>(new Set())

function isExpanded(titleKey: string | null): boolean {
  // Groups without a title (field-worker nav) are always shown.
  return titleKey === null || expandedGroups.value.has(titleKey)
}

function toggleGroup(titleKey: string) {
  const next = new Set(expandedGroups.value)
  if (next.has(titleKey)) next.delete(titleKey)
  else next.add(titleKey)
  expandedGroups.value = next
  try {
    localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify([...next]))
  } catch {
    // Ignore storage failures (private mode, quota) - state stays in memory.
  }
}

function initExpandedGroups() {
  let stored: string[] | null = null
  try {
    const raw = localStorage.getItem(NAV_STORAGE_KEY)
    if (raw) stored = JSON.parse(raw)
  } catch {
    stored = null
  }

  if (stored) {
    expandedGroups.value = new Set(stored)
    return
  }

  // First visit: open only the section that contains the current route.
  const active = navGroups.value.find((g) => g.items.some((i) => i.to === route.path))
  expandedGroups.value = new Set(active?.titleKey ? [active.titleKey] : [])
}

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
          <h1 class="text-lg font-black text-white">{{ t('brand.farm') }}</h1>
          <button type="button" class="text-slate-400 hover:text-white p-2" :aria-label="t('common.close')" @click="closeMenu">
            ✕
          </button>
        </div>
        <nav class="space-y-1.5 flex-1 overflow-auto">
          <div v-for="group in navGroups" :key="group.titleKey ?? 'root'">
            <button
              v-if="group.titleKey"
              type="button"
              :aria-expanded="isExpanded(group.titleKey)"
              class="w-full flex items-center justify-between gap-2 px-3 py-3 rounded-lg text-[11px] font-bold uppercase tracking-wider bg-slate-800/40 text-slate-200 hover:bg-slate-800 active:bg-slate-700 transition-colors cursor-pointer"
              @click="toggleGroup(group.titleKey)"
            >
              <span>{{ t(group.titleKey) }}</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                class="h-4 w-4 shrink-0 transition-transform text-slate-400"
                :class="{ 'rotate-180': isExpanded(group.titleKey) }"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="2.5"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            <div v-show="isExpanded(group.titleKey)" class="space-y-1 mt-1 mb-1">
              <RouterLink
                v-for="link in group.items"
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
            </div>
          </div>
        </nav>
        <div class="pt-4 border-t border-slate-800">
          <p class="text-sm font-semibold text-white">{{ auth.user?.name }}</p>
          <button
            class="mt-3 text-sm text-slate-400 hover:text-red-400 transition-colors min-h-[2.75rem]"
            @click="auth.logout()"
          >
            {{ t('common.signOut') }}
          </button>
          <p class="mt-4 text-[10px] text-slate-600 tracking-wide">
            Well crafted by <span class="text-farm-gold font-semibold">{{ t('brand.name') }}</span>
          </p>
        </div>
      </aside>
    </div>

    <!-- Desktop sidebar -->
    <aside class="hidden md:flex relative z-30 w-64 shrink-0 bg-slate-900 border-r border-slate-800 p-6 flex-col">
      <div class="mb-6 flex items-center justify-between gap-2">
        <h1 class="text-xl font-black text-white leading-tight">{{ t('brand.farm') }}</h1>
        <LanguageSwitcher />
      </div>

      <nav class="space-y-1.5 flex-1 overflow-y-auto">
        <div v-for="group in navGroups" :key="group.titleKey ?? 'root'">
          <button
            v-if="group.titleKey"
            type="button"
            :aria-expanded="isExpanded(group.titleKey)"
            class="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider bg-slate-800/40 text-slate-200 hover:bg-slate-800 active:bg-slate-700 transition-colors cursor-pointer"
            @click="toggleGroup(group.titleKey)"
          >
            <span>{{ t(group.titleKey) }}</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="h-4 w-4 shrink-0 transition-transform text-slate-400"
              :class="{ 'rotate-180': isExpanded(group.titleKey) }"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              stroke-width="2.5"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <div v-show="isExpanded(group.titleKey)" class="space-y-1 mt-1 mb-1">
            <RouterLink
              v-for="link in group.items"
              :key="link.to"
              :to="link.to"
              class="block px-3 py-2 rounded-lg text-sm font-medium transition-colors"
              :class="isActive(link.to)
                ? 'bg-farm-green/20 text-farm-green'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'"
            >
              {{ t(link.labelKey) }}
            </RouterLink>
          </div>
        </div>
      </nav>

      <!-- Desktop sync status -->
      <div class="mt-4 mb-2">
        <div v-if="!onlineStatus" class="flex items-center gap-2 rounded-lg bg-amber-950/50 border border-amber-700/40 px-3 py-2">
          <span class="h-2 w-2 rounded-full bg-amber-400 shrink-0" />
          <p class="text-xs text-amber-300 font-medium">{{ t('offline.short') }} - changes queued</p>
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
        <p class="text-xs text-slate-500">{{ auth.user?.role ? roleLabel(auth.user.role) : '' }}</p>
        <button
          class="mt-3 text-xs text-slate-400 hover:text-red-400 transition-colors"
          @click="auth.logout()"
        >
          {{ t('common.signOut') }}
        </button>
      </div>

      <p class="mt-4 text-[10px] text-slate-600 tracking-wide">
        Well crafted by <span class="text-farm-gold font-semibold">{{ t('brand.name') }}</span>
      </p>
    </aside>

    <main
      ref="mainEl"
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
      <div class="grid grid-cols-4">
        <RouterLink
          to="/today"
          class="flex flex-col items-center justify-center min-h-[4rem] gap-1 text-[11px] font-semibold transition-colors"
          :class="isActive('/today') ? 'text-farm-green' : 'text-slate-400'"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {{ t('nav.today') }}
        </RouterLink>
        <RouterLink
          to="/worker"
          class="flex flex-col items-center justify-center min-h-[4rem] gap-1 text-[11px] font-semibold transition-colors"
          :class="isActive('/worker') ? 'text-farm-green' : 'text-slate-400'"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
          {{ t('nav.myTasks') }}
        </RouterLink>
        <RouterLink
          to="/assets"
          class="flex flex-col items-center justify-center min-h-[4rem] gap-1 text-[11px] font-semibold transition-colors"
          :class="isActive('/assets') ? 'text-farm-green' : 'text-slate-400'"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" />
          </svg>
          {{ t('nav.assets') }}
        </RouterLink>
        <RouterLink
          to="/traceability"
          class="flex flex-col items-center justify-center min-h-[4rem] gap-1 text-[11px] font-semibold transition-colors"
          :class="isActive('/traceability') ? 'text-farm-green' : 'text-slate-400'"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm13 0h3m-3 3h3m-3 3h3" />
          </svg>
          {{ t('nav.harvest') }}
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
