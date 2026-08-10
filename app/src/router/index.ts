import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const workerAllowedNames = new Set([
  'change-password',
  'today',
  'hours',
  'worker',
  'assets',
  'traceability',
  'settings',
  'advisory',
  'field-reports',
  'inventory',
])

const salesAllowedNames = new Set([
  'change-password',
  'today',
  'hours',
  'dashboard',
  'sales',
  'products',
  'whatsapp',
  'traceability',
  'finance',
  'settings',
  'pay-callback',
  'public-lot',
  'support',
  'marketing-leads',
  'shop-customers',
])

function defaultHome(role?: string) {
  if (role === 'field_worker') return '/today'
  if (role === 'sales') return '/sales'
  return '/dashboard'
}

const router = createRouter({
  history: createWebHistory(),
  // Every tab navigation should open at the top of the page. The window is the
  // scroll container, so reset it on navigation (honour back/forward saved position).
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition ?? { top: 0, left: 0 }
  },
  routes: [
    {
      path: '/',
      redirect: () => {
        const auth = useAuthStore()
        return defaultHome(auth.user?.role)
      },
    },
    {
      path: '/change-password',
      name: 'change-password',
      component: () => import('@/views/ChangePasswordView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { guest: true },
    },
    {
      path: '/reset-password',
      name: 'reset-password',
      component: () => import('@/views/ResetPasswordView.vue'),
      meta: { guest: true },
    },
    {
      path: '/register',
      name: 'register',
      component: () => import('@/views/RegisterView.vue'),
      meta: { guest: true },
    },
    {
      path: '/pay/callback',
      name: 'pay-callback',
      component: () => import('@/views/PayCallbackView.vue'),
      // Public post-checkout page (no auth). Do not set guest:true or logged-in
      // staff testing the flow get bounced home.
    },
    {
      path: '/today',
      name: 'today',
      component: () => import('@/views/TodayView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/advisory',
      name: 'advisory',
      component: () => import('@/views/AdvisoryView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/worker',
      name: 'worker',
      component: () => import('@/views/WorkerTasksView.vue'),
      meta: { requiresAuth: true, fieldWorker: true },
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: () => import('@/views/DashboardView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/tasks',
      name: 'tasks',
      component: () => import('@/views/TasksView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/tasks/post-approval',
      name: 'post-approval-tasks',
      component: () => import('@/views/PostApprovalTasksView.vue'),
      meta: { requiresAuth: true, managerOnly: true },
    },
    {
      path: '/inventory',
      name: 'inventory',
      component: () => import('@/views/InventoryView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/field-reports',
      name: 'field-reports',
      component: () => import('@/views/FieldReportsView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/crops',
      name: 'crops',
      component: () => import('@/views/CropsView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/livestock',
      name: 'livestock',
      component: () => import('@/views/LivestockView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/whatsapp',
      name: 'whatsapp',
      component: () => import('@/views/WhatsAppView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/sales',
      name: 'sales',
      component: () => import('@/views/SalesView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/support',
      name: 'support',
      component: () => import('@/views/SupportView.vue'),
      meta: { requiresAuth: true, orderStaffOnly: true },
    },
    {
      path: '/products',
      name: 'products',
      component: () => import('@/views/ProductsView.vue'),
      meta: { requiresAuth: true, orderStaffOnly: true },
    },
    {
      path: '/customer-insights',
      name: 'customer-insights',
      component: () => import('@/views/CustomerInsightsView.vue'),
      meta: { requiresAuth: true, ownerOnly: true },
    },
    {
      path: '/finance',
      name: 'finance',
      component: () => import('@/views/FinanceView.vue'),
      meta: { requiresAuth: true, financeAccess: true },
    },
    {
      path: '/hours',
      name: 'hours',
      component: () => import('@/views/HoursView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/traceability',
      name: 'traceability',
      component: () => import('@/views/TraceabilityView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/assets',
      name: 'assets',
      component: () => import('@/views/AssetsView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/reports',
      name: 'reports',
      component: () => import('@/views/ReportsView.vue'),
      meta: { requiresAuth: true, managerOnly: true },
    },
    {
      path: '/journal',
      name: 'journal',
      component: () => import('@/views/JournalView.vue'),
      meta: { requiresAuth: true, ownerOnly: true },
    },
    {
      path: '/brand-kits',
      name: 'brand-kits',
      component: () => import('@/views/BrandKitsView.vue'),
      meta: { requiresAuth: true, ownerOnly: true },
    },
    {
      path: '/newsletter',
      name: 'newsletter',
      component: () => import('@/views/NewsletterView.vue'),
      meta: { requiresAuth: true, ownerOnly: true },
    },
    {
      path: '/marketing-leads',
      name: 'marketing-leads',
      component: () => import('@/views/MarketingLeadsView.vue'),
      meta: { requiresAuth: true, marketingStaffOnly: true },
    },
    {
      path: '/shop-customers',
      name: 'shop-customers',
      component: () => import('@/views/ShopCustomersView.vue'),
      meta: { requiresAuth: true, marketingStaffOnly: true },
    },
    {
      path: '/moments',
      name: 'moments',
      component: () => import('@/views/MomentsView.vue'),
      meta: { requiresAuth: true, managerOnly: true },
    },
    {
      path: '/careers',
      name: 'careers',
      component: () => import('@/views/CareersView.vue'),
      meta: { requiresAuth: true, ownerOnly: true },
    },
    {
      path: '/templates',
      name: 'templates',
      component: () => import('@/views/TemplatesView.vue'),
      meta: { requiresAuth: true, managerOnly: true },
    },
    {
      path: '/zones',
      name: 'zones',
      component: () => import('@/views/ZonesView.vue'),
      meta: { requiresAuth: true, managerOnly: true },
    },
    {
      path: '/settings/security',
      name: 'settings-security',
      component: () => import('@/views/SecurityView.vue'),
      meta: { requiresAuth: true, ownerOnly: true },
    },
    {
      path: '/settings/audit',
      name: 'settings-audit',
      component: () => import('@/views/AuditView.vue'),
      meta: { requiresAuth: true, auditAccess: true },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/users',
      name: 'users',
      component: () => import('@/views/UsersView.vue'),
      meta: { requiresAuth: true, ownerOnly: true },
    },
    {
      path: '/events',
      name: 'events',
      component: () => import('@/views/EventsView.vue'),
      meta: { requiresAuth: true, managerOnly: true },
    },
    {
      path: '/ai',
      name: 'ai',
      component: () => import('@/views/AiView.vue'),
      meta: { requiresAuth: true, managerOnly: true },
    },
    {
      path: '/lot/:farmSlug/:lotCode',
      name: 'public-lot',
      component: () => import('@/views/PublicLotView.vue'),
    },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (!auth.user && !to.meta.guest) {
    await auth.fetchMe()
  }
  if (to.meta.requiresAuth && !auth.isAuthenticated) {
    return { name: 'login' }
  }
  if (to.meta.guest && auth.isAuthenticated) {
    return defaultHome(auth.user?.role)
  }
  if (to.meta.ownerOnly && auth.user?.role !== 'owner') {
    return defaultHome(auth.user?.role)
  }
  if (to.meta.auditAccess && !auth.hasPermission('audit.export')) {
    return defaultHome(auth.user?.role)
  }
  if (to.meta.financeAccess && !auth.canAccessFinance) {
    return defaultHome(auth.user?.role)
  }
  if (to.meta.orderStaffOnly && !auth.canManageProducts) {
    return defaultHome(auth.user?.role)
  }
  if (
    to.meta.marketingStaffOnly &&
    auth.user?.role !== 'owner' &&
    auth.user?.role !== 'sales'
  ) {
    return defaultHome(auth.user?.role)
  }
  if (to.meta.managerOnly && !auth.canApprove) {
    return defaultHome(auth.user?.role)
  }
  if (to.meta.fieldWorker && auth.user?.role !== 'field_worker') {
    return defaultHome(auth.user?.role)
  }
  if (
    auth.user?.mustChangePassword &&
    to.name !== 'change-password'
  ) {
    return { name: 'change-password' }
  }
  if (
    auth.user?.role === 'field_worker' &&
    to.meta.requiresAuth &&
    to.name &&
    !workerAllowedNames.has(String(to.name))
  ) {
    return { name: 'today' }
  }
  if (
    auth.user?.role === 'sales' &&
    to.meta.requiresAuth &&
    to.name &&
    !salesAllowedNames.has(String(to.name))
  ) {
    return { name: 'sales' }
  }
})

export default router
