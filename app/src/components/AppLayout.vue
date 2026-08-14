<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import LanguageSwitcher from '@/components/LanguageSwitcher.vue'
import ThemeSwitcher from '@/components/ThemeSwitcher.vue'
import TrovaraLogo from '@/components/brand/TrovaraLogo.vue'
import OnboardingGuide from '@/components/OnboardingGuide.vue'
import AccessibleDialog from '@/components/AccessibleDialog.vue'
import { canAccessRoute } from '@/lib/navigation'
import { onlineStatus, pendingSyncCount, lastSyncedAt, syncStatus, retrySync } from '@/lib/offline-api'

defineProps<{ workerMode?: boolean }>()

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const menuOpen = ref(false)
const workerMoreOpen = ref(false)
const retrying = ref(false)
const mainEl = ref<HTMLElement | null>(null)

/** Desktop sidebar width: full labels vs icon rail. Persisted per browser. */
const SIDEBAR_COLLAPSED_KEY = 'trovara_sidebar_collapsed'
const sidebarCollapsed = ref(false)

onMounted(() => {
  mainEl.value?.scrollTo({ top: 0, behavior: 'auto' })
  initExpandedGroups()
  try {
    sidebarCollapsed.value = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    sidebarCollapsed.value = false
  }
})

// AppLayout owns the workspace scroll. Reset it after navigation so a new page
// never opens halfway down, while keeping the sidebar and mobile header stable.
watch(
  () => route.fullPath,
  async () => {
    await nextTick()
    mainEl.value?.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    openActiveGroup()
  },
)

function toggleSidebarCollapsed() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed.value ? '1' : '0')
  } catch {
    // Ignore storage failures (private mode, quota).
  }
}

/** Heroicons-style paths for the collapsed rail (full labels stay on hover/title). */
const NAV_ICON_PATHS: Record<string, string> = {
  '/today': 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  '/advisory':
    'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
  '/worker':
    'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
  '/tasks':
    'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
  '/tasks/post-approval':
    'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
  '/field-reports':
    'M12 9v4m0 4h.01M10.3 3.8L2.7 17a2 2 0 001.7 3h15.2a2 2 0 001.7-3L13.7 3.8a2 2 0 00-3.4 0z',
  '/settings':
    'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
  '/dashboard':
    'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z',
  '/crops':
    'M12 3v2m0 14v2m9-9h-2M5 12H3m13.657-5.657l-1.414 1.414M8.757 15.243l-1.414 1.414m10.314 0l-1.414-1.414M8.757 8.757L7.343 7.343M16 12a4 4 0 11-8 0 4 4 0 018 0z',
  '/livestock':
    'M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z',
  '/inventory':
    'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  '/assets':
    'M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z',
  '/sales':
    'M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z',
  '/support':
    'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
  '/products':
    'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z',
  '/customer-insights':
    'M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  '/whatsapp':
    'M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z',
  '/telegram':
    'M12 19l9 2-9-18-9 18 9-2zm0 0v-8',
  '/traceability': 'M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm13 0h3m-3 3h3m-3 3h3',
  '/events':
    'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  '/ai':
    'M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z',
  '/reports':
    'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  '/journal':
    'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5s3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18s-3.332.477-4.5 1.253',
  '/brand-kits':
    'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z',
  '/moments':
    'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z',
  '/newsletter':
    'M3 8l9 6 9-6m-18 0v9a2 2 0 002 2h14a2 2 0 002-2V8m-14-3h14a2 2 0 012 2v1L12 14 3 8V7a2 2 0 012-2z',
  '/marketing-leads':
    'M17 20h5v-2a4 4 0 00-4-4h-1m-5 6H2v-2a4 4 0 014-4h4a4 4 0 014 4v2zm-4-13a4 4 0 11-8 0 4 4 0 018 0zm7 3a3 3 0 10-6 0',
  '/shop-customers':
    'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
  '/finance':
    'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  '/hours':
    'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  '/templates':
    'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  '/zones':
    'M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z M15 11a3 3 0 11-6 0 3 3 0 016 0z',
  '/users':
    'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z',
}

const NAV_ICON_FALLBACK =
  'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1'

function navIconPath(to: string): string {
  return NAV_ICON_PATHS[to] ?? NAV_ICON_FALLBACK
}

const isFieldWorker = computed(() => auth.user?.role === 'field_worker')
const isSales = computed(() => auth.user?.role === 'sales')
const userInitials = computed(() =>
  (auth.user?.name ?? 'Trovara')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join(''),
)

type NavItem = { to: string; labelKey: string }
type NavGroup = { titleKey: string | null; items: NavItem[] }

// Grouped sidebar. Field workers keep their flat two-item nav; sales get a
// focused sales nav; everyone else (supervisor/owner) sees labelled sections.
const navGroups = computed<NavGroup[]>(() => {
  if (isFieldWorker.value) {
    return [
      {
        titleKey: null,
        items: [
          { to: '/today', labelKey: 'nav.today' },
          { to: '/hours', labelKey: 'nav.hours' },
          { to: '/advisory', labelKey: 'nav.advisory' },
          { to: '/worker', labelKey: 'nav.myTasks' },
          { to: '/field-reports', labelKey: 'nav.fieldReports' },
          { to: '/inventory', labelKey: 'nav.inventory' },
          { to: '/assets', labelKey: 'nav.assets' },
          { to: '/traceability', labelKey: 'nav.harvest' },
          { to: '/settings', labelKey: 'nav.settings' },
        ],
      },
    ]
  }

  if (isSales.value) {
    return [
      {
        titleKey: 'nav.grpOverview',
        items: [
          { to: '/dashboard', labelKey: 'nav.dashboard' },
          { to: '/today', labelKey: 'nav.today' },
          { to: '/hours', labelKey: 'nav.hours' },
        ],
      },
      {
        titleKey: 'nav.grpSales',
        items: [
          { to: '/sales', labelKey: 'nav.sales' },
          { to: '/support', labelKey: 'nav.support' },
          { to: '/marketing-leads', labelKey: 'nav.marketingLeads' },
          { to: '/shop-customers', labelKey: 'nav.shopCustomers' },
          { to: '/products', labelKey: 'nav.products' },
          { to: '/whatsapp', labelKey: 'nav.whatsapp' },
          { to: '/telegram', labelKey: 'nav.telegram' },
          { to: '/traceability', labelKey: 'nav.traceability' },
          { to: '/finance', labelKey: 'nav.finance' },
        ],
      },
      {
        titleKey: 'nav.grpSetup',
        items: [{ to: '/settings', labelKey: 'nav.settings' }],
      },
    ]
  }

  const groups: NavGroup[] = [
    {
      titleKey: 'nav.grpOverview',
      items: [
        { to: '/dashboard', labelKey: 'nav.dashboard' },
        { to: '/today', labelKey: 'nav.today' },
        { to: '/hours', labelKey: 'nav.hours' },
        { to: '/advisory', labelKey: 'nav.advisory' },
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
        { to: '/field-reports', labelKey: 'nav.fieldReports' },
      ],
    },
    {
      titleKey: 'nav.grpSales',
      items: [
        { to: '/sales', labelKey: 'nav.sales' },
        { to: '/support', labelKey: 'nav.support' },
        { to: '/products', labelKey: 'nav.products' },
        { to: '/customer-insights', labelKey: 'nav.customerInsights' },
        { to: '/shop-customers', labelKey: 'nav.shopCustomers' },
        { to: '/whatsapp', labelKey: 'nav.whatsapp' },
        { to: '/telegram', labelKey: 'nav.telegram' },
      ],
    },
    {
      titleKey: 'nav.grpContent',
      items: [
        { to: '/marketing-leads', labelKey: 'nav.marketingLeads' },
        { to: '/journal', labelKey: 'nav.journal' },
        { to: '/brand-kits', labelKey: 'nav.brandKits' },
        { to: '/moments', labelKey: 'nav.moments' },
        { to: '/careers', labelKey: 'nav.careers' },
        { to: '/newsletter', labelKey: 'nav.newsletter' },
      ],
    },
    {
      titleKey: 'nav.grpInsights',
      items: [
        { to: '/traceability', labelKey: 'nav.traceability' },
        { to: '/events', labelKey: 'nav.events' },
        { to: '/ai', labelKey: 'nav.ai' },
        { to: '/reports', labelKey: 'nav.reports' },
        { to: '/finance', labelKey: 'nav.finance' },
        { to: '/tasks/post-approval', labelKey: 'nav.postApproval' },
      ],
    },
    {
      titleKey: 'nav.grpSetup',
      items: [
        { to: '/templates', labelKey: 'nav.templates' },
        { to: '/zones', labelKey: 'nav.zones' },
        { to: '/users', labelKey: 'nav.users' },
        { to: '/settings', labelKey: 'nav.settings' },
      ],
    },
  ]

  return groups
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => {
        return canAccessRoute(auth.user, router.resolve(i.to).meta)
      }),
    }))
    .filter((g) => g.items.length > 0)
})

const flatNavItems = computed(() => navGroups.value.flatMap((group) => group.items))
const workerMoreItems = computed(() =>
  flatNavItems.value.filter((item) =>
    ['/hours', '/advisory', '/inventory', '/settings', '/traceability'].includes(item.to),
  ),
)

const guidePages = computed(() => {
  const pages = flatNavItems.value.map(({ to, labelKey }) => ({ to, labelKey }))
  if (isFieldWorker.value) {
    if (!pages.some((page) => page.to === '/assets')) {
      pages.push({ to: '/assets', labelKey: 'nav.assets' })
    }
    if (!pages.some((page) => page.to === '/traceability')) {
      pages.push({ to: '/traceability', labelKey: 'nav.harvest' })
    }
  }
  return pages
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
  // Accordion behavior keeps a long owner menu scannable: one section at a time.
  const next = expandedGroups.value.has(titleKey) ? new Set<string>() : new Set([titleKey])
  expandedGroups.value = next
  try {
    localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify([...next]))
  } catch {
    // Ignore storage failures (private mode, quota) - state stays in memory.
  }
}

function groupForPath(path: string): string | null {
  const exact = navGroups.value.find((group) => group.items.some((item) => path === item.to))
  if (exact?.titleKey) return exact.titleKey

  const prefixes = navGroups.value.flatMap((group) =>
    group.items.map((item) => ({ titleKey: group.titleKey, to: item.to })),
  )
  prefixes.sort((a, b) => b.to.length - a.to.length)
  return prefixes.find((item) => path.startsWith(`${item.to}/`))?.titleKey ?? null
}

function openActiveGroup() {
  const activeGroup = groupForPath(route.path)
  if (!activeGroup || expandedGroups.value.has(activeGroup)) return
  expandedGroups.value = new Set([activeGroup])
  try {
    localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify([activeGroup]))
  } catch {
    // Ignore storage failures (private mode, quota) - state stays in memory.
  }
}

function initExpandedGroups() {
  let stored: string[] = []
  try {
    const raw = localStorage.getItem(NAV_STORAGE_KEY)
    if (raw) stored = JSON.parse(raw)
  } catch {
    stored = []
  }

  const activeGroup = groupForPath(route.path)
  if (activeGroup) {
    expandedGroups.value = new Set([activeGroup])
    return
  }

  const validKeys = new Set(
    navGroups.value.map((group) => group.titleKey).filter((key): key is string => Boolean(key)),
  )
  const storedGroup = stored.find((key) => validKeys.has(key))
  expandedGroups.value = storedGroup ? new Set([storedGroup]) : new Set()
}

function closeMenu() {
  menuOpen.value = false
  workerMoreOpen.value = false
}

function isActive(path: string) {
  return route.path === path
}

const activeNavLabel = computed(() => {
  const active = navGroups.value.flatMap((group) => group.items).find((item) => item.to === route.path)
  return active ? t(active.labelKey) : t('brand.farm')
})

const guidePageTitle = computed(() => {
  if (route.path === '/settings/security' || route.path === '/settings/audit') return t('nav.settings')
  const page = guidePages.value.find((item) => item.to === route.path)
  return page ? t(page.labelKey) : activeNavLabel.value
})

function translatedRole(role: string): string {
  const key = `roles.${role}`
  const translated = t(key)
  return translated === key ? role : translated
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
  <div class="h-dvh w-full max-w-[100vw] overflow-hidden flex flex-col md:flex-row bg-[var(--os-canvas)]">
    <!-- Mobile header -->
    <header class="md:hidden sticky top-0 z-40 flex items-center gap-2 px-3 py-3 bg-[var(--os-shell)]/95 backdrop-blur-xl border-b border-[color:var(--os-border)] min-w-0 max-w-full safe-area-x safe-area-pt">
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
      <div class="min-w-0 flex-1 flex items-center gap-3">
        <TrovaraLogo compact class="shrink-0" />
        <h1 class="hidden min-[420px]:block min-w-0 truncate border-l border-white/10 pl-3 text-xs font-bold text-slate-400">
          {{ activeNavLabel }}
        </h1>
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
        <ThemeSwitcher compact />
        <LanguageSwitcher compact />
      </div>
    </header>

    <!-- Mobile drawer -->
    <AccessibleDialog
      :open="menuOpen && !isFieldWorker"
      title-id="mobile-nav-title"
      :close-label="t('common.close')"
      variant="drawer"
      @close="closeMenu"
    >
      <aside class="h-full w-72 bg-[var(--os-shell)] border-r border-[color:var(--os-border)] p-6 flex flex-col shadow-2xl">
        <div class="mb-6 flex items-center justify-between gap-2">
          <div id="mobile-nav-title"><TrovaraLogo /></div>
          <div class="flex items-center gap-1">
            <ThemeSwitcher compact />
            <button type="button" class="text-slate-400 hover:text-white p-2" :aria-label="t('common.close')" @click="closeMenu">
              ✕
            </button>
          </div>
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
        <div class="pt-4 border-t border-slate-800 space-y-3">
          <p class="text-sm font-semibold text-white">{{ auth.user?.name }}</p>
          <button
            class="text-sm text-slate-400 hover:text-red-400 transition-colors min-h-[2.75rem]"
            @click="auth.logout()"
          >
            {{ t('common.signOut') }}
          </button>
          <p class="text-[10px] text-slate-600 tracking-wide">
            {{ t('common.craftedBy') }} <span class="text-farm-gold font-semibold">{{ t('brand.name') }}</span>
          </p>
        </div>
      </aside>
    </AccessibleDialog>

    <!-- Desktop sidebar (collapsible) -->
    <aside
      class="hidden md:flex relative z-30 shrink-0 bg-[var(--os-shell)] border-r border-[color:var(--os-border)] py-5 flex-col shadow-[18px_0_50px_rgba(0,0,0,0.12)] transition-[width,padding] duration-200 ease-out"
      :class="sidebarCollapsed ? 'w-[4.5rem] px-2' : 'w-72 px-4'"
      :aria-expanded="!sidebarCollapsed"
    >
      <div class="mb-5" :class="sidebarCollapsed ? 'px-0' : 'px-2'">
        <div
          class="flex items-start gap-2"
          :class="sidebarCollapsed ? 'flex-col items-center gap-3' : 'justify-between'"
        >
          <div :class="sidebarCollapsed ? 'flex justify-center' : 'min-w-0'">
            <TrovaraLogo :compact="sidebarCollapsed" />
            <p
              v-if="!sidebarCollapsed"
              class="text-[11px] text-slate-500 mt-2 ml-[3.35rem]"
            >
              {{ t('brand.workspace') }}
            </p>
          </div>
          <button
            type="button"
            class="h-8 w-8 rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 transition-colors grid place-items-center shrink-0"
            :aria-label="sidebarCollapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')"
            :title="sidebarCollapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')"
            @click="toggleSidebarCollapsed"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="h-4 w-4 transition-transform duration-200"
              :class="sidebarCollapsed ? 'rotate-180' : ''"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Collapsed: icon rail (hover shows the full name) -->
      <nav
        v-if="sidebarCollapsed"
        class="flex-1 overflow-y-auto os-scrollbar flex flex-col items-center gap-1"
        aria-label="Primary navigation"
      >
        <RouterLink
          v-for="link in flatNavItems"
          :key="link.to"
          :to="link.to"
          class="h-10 w-10 rounded-xl grid place-items-center transition-all"
          :class="isActive(link.to)
            ? 'bg-farm-green/20 text-farm-green ring-1 ring-inset ring-farm-green/30'
            : 'text-slate-400 hover:text-white hover:bg-white/5'"
          :title="t(link.labelKey)"
          :aria-label="t(link.labelKey)"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="1.75"
            aria-hidden="true"
          >
            <path stroke-linecap="round" stroke-linejoin="round" :d="navIconPath(link.to)" />
          </svg>
        </RouterLink>
      </nav>

      <!-- Expanded: grouped sections -->
      <nav
        v-else
        class="space-y-3 flex-1 overflow-y-auto pr-1 os-scrollbar"
        aria-label="Primary navigation"
      >
        <div v-for="group in navGroups" :key="group.titleKey ?? 'root'">
          <button
            v-if="group.titleKey"
            type="button"
            :aria-expanded="isExpanded(group.titleKey)"
            class="w-full flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-[0.18em] text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
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
          <div v-show="isExpanded(group.titleKey)" class="space-y-0.5 mt-1">
            <RouterLink
              v-for="link in group.items"
              :key="link.to"
              :to="link.to"
              class="relative block px-3 py-2 rounded-xl text-[13px] font-semibold transition-all"
              :class="isActive(link.to)
                ? 'bg-farm-green/15 text-farm-green shadow-sm ring-1 ring-inset ring-farm-green/20 before:content-[\'\'] before:absolute before:left-0 before:top-2 before:bottom-2 before:w-0.5 before:rounded-full before:bg-farm-green'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'"
            >
              {{ t(link.labelKey) }}
            </RouterLink>
          </div>
        </div>
      </nav>

      <!-- Desktop sync status (full labels when expanded) -->
      <div class="mt-4 mb-2">
        <template v-if="!sidebarCollapsed">
          <div v-if="!onlineStatus" class="flex items-center gap-2 rounded-lg bg-amber-950/50 border border-amber-700/40 px-3 py-2">
            <span class="h-2 w-2 rounded-full bg-amber-400 shrink-0" />
            <p class="text-xs text-amber-300 font-medium">{{ t('offline.queued') }}</p>
          </div>
          <div v-else-if="syncStatus === 'error'" class="flex items-center justify-between gap-2 rounded-lg bg-red-950/50 border border-red-700/40 px-3 py-2">
            <div class="flex items-center gap-2">
              <span class="h-2 w-2 rounded-full bg-red-400 shrink-0" />
              <p class="text-xs text-red-300 font-medium">{{ t('offline.syncFailed') }}</p>
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
            <p class="text-xs text-blue-300 font-medium">{{ t('offline.syncing', { count: pendingSyncCount }) }}</p>
          </div>
          <div v-else-if="lastSyncedAt" class="px-1">
            <p class="text-[10px] text-slate-600">Synced {{ formatSyncTime(lastSyncedAt) }}</p>
          </div>
        </template>
        <div
          v-else-if="!onlineStatus || pendingSyncCount > 0 || syncStatus === 'error'"
          class="mx-auto h-2.5 w-2.5 rounded-full"
          :class="{
            'bg-amber-400': !onlineStatus,
            'bg-red-400': onlineStatus && syncStatus === 'error',
            'bg-blue-400 animate-pulse': onlineStatus && syncStatus !== 'error' && pendingSyncCount > 0,
          }"
          :title="!onlineStatus ? t('offline.short') : syncStatus === 'error' ? t('offline.syncFailed') : t('offline.pendingSync', { count: pendingSyncCount })"
        />
      </div>

      <div
        v-if="!sidebarCollapsed"
        class="mb-3 flex flex-col items-start gap-2 px-1"
      >
        <ThemeSwitcher compact />
        <LanguageSwitcher compact />
      </div>
      <div
        v-else
        class="mb-3 flex flex-col items-center gap-2"
      >
        <ThemeSwitcher compact toggle-only />
        <LanguageSwitcher compact toggle-only />
      </div>
      <div
        class="pt-4 border-t border-[color:var(--os-border)] flex items-center"
        :class="sidebarCollapsed ? 'flex-col gap-2' : 'gap-3'"
      >
        <div
          class="h-9 w-9 rounded-full bg-[var(--os-shell-muted)] text-farm-green grid place-items-center text-xs font-black shrink-0"
          :title="auth.user?.name ?? ''"
        >
          {{ userInitials }}
        </div>
        <div v-if="!sidebarCollapsed" class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-white truncate">{{ auth.user?.name }}</p>
          <p class="text-[11px] text-slate-500 truncate">{{ auth.user?.role ? translatedRole(auth.user.role) : '' }}</p>
        </div>
        <button
          class="h-9 w-9 rounded-xl text-slate-500 hover:text-red-300 hover:bg-red-500/10 transition-colors grid place-items-center shrink-0"
          :aria-label="t('common.signOut')"
          @click="auth.logout()"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 8l-4 4 4 4m-4-4h11m0-7h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2"/></svg>
        </button>
      </div>
    </aside>

    <main
      ref="mainEl"
      class="os-workspace flex-1 min-h-0 min-w-0 w-full max-w-full p-3 sm:p-4 md:p-8 lg:p-10 overflow-x-hidden overflow-y-auto overscroll-y-contain os-scrollbar safe-area-x"
      :class="{ 'pb-[calc(5rem+env(safe-area-inset-bottom))]': isFieldWorker || workerMode }"
    >
      <div class="min-w-0 max-w-[90rem] mx-auto break-words">
        <slot />
      </div>
    </main>

    <OnboardingGuide
      v-if="auth.user"
      :user-id="auth.user.id"
      :user-name="auth.user.name"
      :role="auth.user.role"
      :pages="guidePages"
      :current-path="route.path"
      :current-title="guidePageTitle"
      :disabled="route.name === 'change-password'"
    />

    <!-- Mobile bottom nav for field workers -->
    <nav
      v-if="isFieldWorker"
      class="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[var(--os-shell)]/95 backdrop-blur border-t border-[color:var(--os-border)] safe-area-pb"
    >
      <div class="grid grid-cols-5">
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
          to="/field-reports"
          class="flex flex-col items-center justify-center min-h-[4rem] gap-1 text-[10px] font-semibold transition-colors"
          :class="isActive('/field-reports') ? 'text-farm-green' : 'text-slate-400'"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.3 3.8L2.7 17a2 2 0 001.7 3h15.2a2 2 0 001.7-3L13.7 3.8a2 2 0 00-3.4 0z" />
          </svg>
          {{ t('nav.reportIssue') }}
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
        <button
          type="button"
          class="flex flex-col items-center justify-center min-h-[4rem] gap-1 text-[11px] font-semibold transition-colors"
          :class="workerMoreItems.some((item) => isActive(item.to)) ? 'text-farm-green' : 'text-slate-400'"
          :aria-expanded="workerMoreOpen"
          @click="workerMoreOpen = true"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 12h.01M12 12h.01M19 12h.01" />
          </svg>
          {{ t('nav.more') }}
        </button>
      </div>
    </nav>

    <AccessibleDialog
      :open="workerMoreOpen"
      title-id="worker-more-title"
      :close-label="t('common.close')"
      @close="workerMoreOpen = false"
    >
      <div class="p-5">
        <div class="flex items-center justify-between gap-3">
          <h2 id="worker-more-title" class="text-lg font-bold text-white">{{ t('nav.more') }}</h2>
          <button type="button" class="rounded-lg p-2 text-slate-400" :aria-label="t('common.close')" @click="workerMoreOpen = false">✕</button>
        </div>
        <nav class="mt-4 grid gap-2">
          <RouterLink
            v-for="item in workerMoreItems"
            :key="item.to"
            :to="item.to"
            class="rounded-xl border border-slate-700 px-4 py-3 font-semibold text-slate-200"
            @click="workerMoreOpen = false"
          >
            {{ t(item.labelKey) }}
          </RouterLink>
        </nav>
      </div>
    </AccessibleDialog>
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

.os-workspace {
  background:
    radial-gradient(circle at 100% 0%, var(--os-wash), transparent 32rem),
    linear-gradient(145deg, var(--os-canvas) 0%, var(--os-canvas-mid) 58%, var(--os-canvas-end) 100%);
}

.os-scrollbar {
  scrollbar-width: thin;
  scrollbar-color: rgba(148, 163, 184, 0.18) transparent;
  scrollbar-gutter: stable;
  -webkit-overflow-scrolling: touch;
}

.os-scrollbar::-webkit-scrollbar {
  width: 8px;
}

.os-scrollbar::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.22);
  background-clip: padding-box;
}

.os-scrollbar::-webkit-scrollbar-thumb:hover {
  background: rgba(148, 163, 184, 0.4);
  background-clip: padding-box;
}
</style>
