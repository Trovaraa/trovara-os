import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { canAccessRoute, defaultHome } from '@/lib/navigation'

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
      meta: { requiresAuth: true, fieldWorkerOnly: true, requiredPermission: 'tasks.work_own' },
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: () => import('@/views/DashboardView.vue'),
      meta: { requiresAuth: true, allowedRoles: ['owner', 'supervisor', 'sales'] },
    },
    {
      path: '/tasks',
      name: 'tasks',
      component: () => import('@/views/TasksView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'tasks.assign' },
    },
    {
      path: '/tasks/post-approval',
      name: 'post-approval-tasks',
      component: () => import('@/views/PostApprovalTasksView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'tasks.approve' },
    },
    {
      path: '/inventory',
      name: 'inventory',
      component: () => import('@/views/InventoryView.vue'),
      meta: { requiresAuth: true, anyPermission: ['inventory.read', 'inventory.count'] },
    },
    {
      path: '/field-reports',
      name: 'field-reports',
      component: () => import('@/views/FieldReportsView.vue'),
      meta: { requiresAuth: true, allowedRoles: ['owner', 'supervisor', 'field_worker'] },
    },
    {
      path: '/crops',
      name: 'crops',
      component: () => import('@/views/CropsView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'crops.manage' },
    },
    {
      path: '/livestock',
      name: 'livestock',
      component: () => import('@/views/LivestockView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'livestock.manage' },
    },
    {
      path: '/whatsapp',
      name: 'whatsapp',
      component: () => import('@/views/WhatsAppView.vue'),
      meta: { requiresAuth: true, anyPermission: ['whatsapp.send', 'whatsapp.configure'] },
    },
    {
      path: '/telegram',
      name: 'telegram',
      component: () => import('@/views/TelegramView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'telegram.send' },
    },
    {
      path: '/sales',
      name: 'sales',
      component: () => import('@/views/SalesView.vue'),
      meta: {
        requiresAuth: true,
        allowedRoles: ['owner', 'supervisor', 'sales'],
        requiredPermission: 'orders.read',
      },
    },
    {
      path: '/support',
      name: 'support',
      component: () => import('@/views/SupportView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'orders.manage' },
    },
    {
      path: '/products',
      name: 'products',
      component: () => import('@/views/ProductsView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'products.manage' },
    },
    {
      path: '/customer-insights',
      name: 'customer-insights',
      component: () => import('@/views/CustomerInsightsView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'orders.pii' },
    },
    {
      path: '/finance',
      name: 'finance',
      component: () => import('@/views/FinanceView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'finance.read' },
    },
    {
      path: '/hours',
      name: 'hours',
      component: () => import('@/views/HoursView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/operations-library',
      name: 'operations-library',
      component: () => import('@/views/OperationsLibraryView.vue'),
      meta: { requiresAuth: true, anyPermission: ['knowledge.read', 'knowledge.write'] },
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
      meta: { requiresAuth: true, allowedRoles: ['owner', 'supervisor', 'field_worker'] },
    },
    {
      path: '/maintenance',
      name: 'maintenance',
      component: () => import('@/views/MaintenanceView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'maintenance.read' },
    },
    {
      path: '/scan',
      name: 'scan',
      component: () => import('@/views/ScannerView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'scan.use' },
    },
    {
      path: '/contractors',
      name: 'contractors',
      component: () => import('@/views/ContractorsView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'contractors.read' },
    },
    {
      path: '/reports',
      name: 'reports',
      component: () => import('@/views/ReportsView.vue'),
      meta: {
        requiresAuth: true,
        requiredPermission: 'reports.read',
        anyPermission: ['tasks.approve', 'finance.read', 'audit.export'],
      },
    },
    {
      path: '/anomalies',
      name: 'anomalies',
      component: () => import('@/views/AnomaliesView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'anomalies.read' },
    },
    {
      path: '/journal',
      name: 'journal',
      component: () => import('@/views/JournalView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'journal.manage' },
    },
    {
      path: '/brand-kits',
      name: 'brand-kits',
      component: () => import('@/views/BrandKitsView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'brand.manage' },
    },
    {
      path: '/newsletter',
      name: 'newsletter',
      component: () => import('@/views/NewsletterView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'newsletter.manage' },
    },
    {
      path: '/marketing-leads',
      name: 'marketing-leads',
      component: () => import('@/views/MarketingLeadsView.vue'),
      meta: {
        requiresAuth: true,
        requiredPermission: 'leads.manage',
      },
    },
    {
      path: '/customer-surveys',
      name: 'customer-surveys',
      component: () => import('@/views/CustomerSurveysView.vue'),
      meta: {
        requiresAuth: true,
        requiredPermission: 'leads.manage',
      },
    },
    {
      path: '/shop-customers',
      name: 'shop-customers',
      component: () => import('@/views/ShopCustomersView.vue'),
      meta: {
        requiresAuth: true,
        anyPermission: ['orders.manage', 'finance.read', 'newsletter.manage', 'leads.manage'],
      },
    },
    {
      path: '/moments',
      name: 'moments',
      component: () => import('@/views/MomentsView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'moments.manage' },
    },
    {
      path: '/careers',
      name: 'careers',
      component: () => import('@/views/CareersView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'careers.manage' },
    },
    {
      path: '/templates',
      name: 'templates',
      component: () => import('@/views/TemplatesView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'tasks.assign' },
    },
    {
      path: '/zones',
      name: 'zones',
      component: () => import('@/views/ZonesView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'zones.manage' },
    },
    {
      path: '/settings/security',
      name: 'settings-security',
      component: () => import('@/views/SecurityView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'security.admin' },
    },
    {
      path: '/settings/audit',
      name: 'settings-audit',
      component: () => import('@/views/AuditView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'audit.export' },
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
      meta: { requiresAuth: true, requiredPermission: 'users.view' },
    },
    {
      path: '/events',
      name: 'events',
      component: () => import('@/views/EventsView.vue'),
      meta: { requiresAuth: true, allowedRoles: ['owner', 'supervisor'] },
    },
    {
      path: '/ai',
      name: 'ai',
      component: () => import('@/views/AiView.vue'),
      meta: { requiresAuth: true, requiredPermission: 'ai.use' },
    },
    {
      path: '/lot/:farmSlug/:lotCode',
      name: 'public-lot',
      component: () => import('@/views/PublicLotView.vue'),
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
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
  if (!canAccessRoute(auth.user, to.meta)) {
    return defaultHome(auth.user?.role)
  }
  if (
    auth.user?.mustChangePassword &&
    to.name !== 'change-password'
  ) {
    return { name: 'change-password' }
  }
})

export default router
