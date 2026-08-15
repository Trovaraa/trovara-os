<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import LanguageSwitcher from '@/components/LanguageSwitcher.vue'
import { onboardingCopy, pageGuide } from '@/lib/onboarding'
import type { UserRole } from '@/stores/auth'

type GuidePage = { to: string; labelKey: string }

const props = defineProps<{
  userId: string
  userName: string
  role: UserRole
  pages: GuidePage[]
  currentPath: string
  currentTitle: string
  disabled?: boolean
}>()

const { locale, t } = useI18n()
const open = ref(false)
const mode = ref<'tour' | 'page'>('tour')
const step = ref(0)
const TOTAL_STEPS = 5
const STORAGE_VERSION = '2026-08-guided-v2'

const copy = computed(() => onboardingCopy(String(locale.value)))
const roleGuide = computed(() => copy.value.roles[props.role])
const currentGuide = computed(() => pageGuide(copy.value, props.currentPath, props.role))
const canSeeContribution = computed(() => props.role === 'owner' || props.role === 'supervisor')
const storageKey = computed(() => `trovara_onboarding:${STORAGE_VERSION}:${props.userId}`)

const explainedPages = computed(() =>
  props.pages.map((page) => ({
    ...page,
    label: t(page.labelKey),
    guide: pageGuide(copy.value, page.to, props.role),
  })),
)

function rememberComplete() {
  try {
    localStorage.setItem(storageKey.value, 'complete')
  } catch {
    // The guide still works when storage is unavailable; it may appear again later.
  }
}

function closeAndRemember() {
  rememberComplete()
  open.value = false
}

function showPageHelp() {
  mode.value = 'page'
  open.value = true
}

function showFullGuide() {
  mode.value = 'tour'
  step.value = 0
  open.value = true
}

function nextStep() {
  if (step.value < TOTAL_STEPS - 1) step.value += 1
  else closeAndRemember()
}

function previousStep() {
  if (step.value > 0) step.value -= 1
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !open.value) return
  if (mode.value === 'page') open.value = false
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  if (props.disabled) return
  let completed = false
  try {
    completed = localStorage.getItem(storageKey.value) === 'complete'
  } catch {
    completed = false
  }
  if (!completed) {
    window.setTimeout(() => {
      mode.value = 'tour'
      step.value = 0
      open.value = true
    }, 450)
  }
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <!-- Keep Help independent of the sidebar. It remains visible when the menu is
       collapsed, when a sidebar section scrolls, and on every mobile role. -->
  <Teleport to="body">
    <button
      v-if="!disabled && !open"
      type="button"
      class="fixed right-0 top-[42%] z-50 inline-flex h-12 w-11 -translate-y-1/2 items-center justify-center rounded-l-full border border-r-0 border-farm-gold/45 bg-[var(--os-shell)] text-sm font-black text-farm-gold shadow-xl shadow-black/30 transition hover:border-farm-gold hover:bg-[var(--os-shell-muted)] focus:outline-none focus:ring-2 focus:ring-farm-gold sm:right-4 sm:top-auto sm:w-auto sm:translate-y-0 sm:gap-2 sm:rounded-full sm:border-r sm:px-4 md:right-6"
      :class="role === 'field_worker' ? 'sm:bottom-[calc(5.25rem+env(safe-area-inset-bottom))] md:bottom-6' : 'sm:bottom-[calc(1rem+env(safe-area-inset-bottom))] md:bottom-6'"
      :aria-label="copy.help"
      :title="copy.help"
      data-testid="page-help-trigger"
      @click="showPageHelp"
    >
      <svg class="h-[1.125rem] w-[1.125rem]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9.7 18h4.6M10 22h4m-7.6-8.8A7 7 0 1117.6 8c0 2.1-.9 3.5-2.3 4.9-.8.8-1.3 1.5-1.3 2.6h-4c0-1.1-.5-1.8-1.3-2.6a7.8 7.8 0 01-2.3-4.9" />
      </svg>
      <span class="hidden sm:inline">{{ copy.help }}</span>
    </button>
  </Teleport>

  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[100] grid place-items-center bg-black/75 p-3 sm:p-5 backdrop-blur-sm"
      role="presentation"
    >
      <section
        class="relative flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-[color:var(--os-border)] bg-[var(--os-shell)] text-os-fg shadow-2xl"
        role="dialog"
        aria-modal="true"
        :aria-label="mode === 'page' ? copy.pageHelp : copy.welcome(userName)"
      >
        <header class="flex items-start justify-between gap-4 border-b border-[color:var(--os-border)] px-5 py-4 sm:px-7">
          <div class="flex min-w-0 items-center gap-3">
            <div class="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-farm-green/15 text-farm-green">
              <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9.7 18h4.6M10 22h4m-7.6-8.8A7 7 0 1117.6 8c0 2.1-.9 3.5-2.3 4.9-.8.8-1.3 1.5-1.3 2.6h-4c0-1.1-.5-1.8-1.3-2.6a7.8 7.8 0 01-2.3-4.9" />
              </svg>
            </div>
            <div class="min-w-0">
              <p class="text-[10px] font-black uppercase tracking-[0.2em] text-farm-green">
                {{ mode === 'page' ? copy.help : copy.step(step + 1, TOTAL_STEPS) }}
              </p>
              <h2 class="truncate text-lg font-black sm:text-xl">
                {{ mode === 'page' ? currentTitle : 'Trovara OS' }}
              </h2>
            </div>
          </div>
          <button
            v-if="mode === 'page'"
            type="button"
            class="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-slate-400 hover:bg-white/5 hover:text-white"
            :aria-label="copy.close"
            @click="open = false"
          >
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </header>

        <div v-if="mode === 'page'" class="overflow-y-auto px-5 py-6 sm:px-7 sm:py-8">
          <p class="text-xs font-black uppercase tracking-[0.18em] text-farm-gold">{{ copy.pageHelp }}</p>
          <h3 class="mt-2 text-2xl font-black sm:text-3xl">{{ currentTitle }}</h3>
          <section class="mt-4 rounded-2xl border border-farm-gold/25 bg-farm-gold/10 p-4" :aria-label="copy.roleHeading">
            <p class="text-[10px] font-black uppercase tracking-[0.18em] text-farm-gold">{{ copy.assignedRole }}</p>
            <p class="mt-1.5 text-sm font-semibold leading-6">
              {{ copy.pageRoleLead(roleGuide.title) }}
            </p>
          </section>
          <div class="mt-5 rounded-2xl border border-farm-green/20 bg-farm-green/10 p-5">
            <p class="font-semibold leading-7">{{ currentGuide.summary }}</p>
          </div>
          <ol class="mt-5 space-y-3">
            <li v-for="(action, index) in currentGuide.actions" :key="action" class="flex gap-3 rounded-2xl border border-[color:var(--os-border)] p-4">
              <span class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-farm-green text-xs font-black text-white">{{ index + 1 }}</span>
              <span class="text-sm leading-6">{{ action }}</span>
            </li>
          </ol>
          <details
            v-if="canSeeContribution"
            class="group mt-6 rounded-2xl border border-[color:var(--os-border)] bg-[var(--os-canvas)]"
            data-testid="contribution-help"
          >
            <summary class="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 font-black text-farm-green focus:outline-none focus-visible:ring-2 focus-visible:ring-farm-green">
              <span>{{ copy.contributionTitle }}</span>
              <svg class="h-5 w-5 shrink-0 transition-transform group-open:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
              </svg>
            </summary>
            <div class="border-t border-[color:var(--os-border)] px-5 py-5">
              <p class="text-sm leading-6 text-os-fg-muted">{{ copy.contributionBody }}</p>
              <ol class="mt-4 space-y-3">
                <li v-for="(item, index) in copy.contributionSteps" :key="item" class="flex gap-3 text-sm leading-6">
                  <span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-farm-green/15 text-xs font-black text-farm-green">{{ index + 1 }}</span>
                  <span>{{ item }}</span>
                </li>
              </ol>
              <p class="mt-5 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-xs font-semibold leading-5 text-red-200">
                {{ copy.contributionSafety }}
              </p>
            </div>
          </details>
        </div>

        <div v-else class="overflow-y-auto px-5 py-6 sm:px-7 sm:py-8">
          <template v-if="step === 0">
            <p class="text-xs font-black uppercase tracking-[0.18em] text-farm-gold">{{ copy.assignedRole }}</p>
            <h3 class="mt-2 text-3xl font-black sm:text-4xl">{{ copy.welcome(userName) }}</h3>
            <p class="mt-4 max-w-2xl text-base leading-7 text-os-fg-muted">{{ copy.welcomeBody }}</p>
            <div class="mt-7 rounded-2xl border border-[color:var(--os-border)] bg-[var(--os-canvas)] p-5">
              <p class="mb-4 text-sm font-semibold">{{ copy.languagePrompt }}</p>
              <LanguageSwitcher />
            </div>
          </template>

          <template v-else-if="step === 1">
            <p class="text-xs font-black uppercase tracking-[0.18em] text-farm-gold">{{ copy.roleHeading }}</p>
            <h3 class="mt-2 text-3xl font-black">{{ roleGuide.title }}</h3>
            <p class="mt-3 text-sm leading-6 text-os-fg-muted">{{ copy.roleBody }}</p>
            <div class="mt-6 rounded-2xl bg-farm-green/10 p-5">
              <p class="font-semibold leading-7">{{ roleGuide.summary }}</p>
            </div>
            <ul class="mt-5 space-y-3">
              <li v-for="duty in roleGuide.duties" :key="duty" class="flex gap-3 text-sm leading-6">
                <span class="mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-farm-green text-[10px] font-black text-white">✓</span>
                {{ duty }}
              </li>
            </ul>
          </template>

          <template v-else-if="step === 2">
            <p class="text-xs font-black uppercase tracking-[0.18em] text-farm-gold">{{ roleGuide.title }}</p>
            <h3 class="mt-2 text-3xl font-black">{{ copy.yourPages }}</h3>
            <p class="mt-3 text-sm leading-6 text-os-fg-muted">{{ copy.pagesBody }}</p>
            <div class="mt-6 grid gap-3 sm:grid-cols-2">
              <article v-for="page in explainedPages" :key="page.to" class="rounded-2xl border border-[color:var(--os-border)] bg-[var(--os-canvas)] p-4">
                <h4 class="font-black text-farm-green">{{ page.label }}</h4>
                <p class="mt-1.5 text-xs leading-5 text-os-fg-muted">{{ page.guide.summary }}</p>
              </article>
            </div>
          </template>

          <template v-else-if="step === 3">
            <p class="text-xs font-black uppercase tracking-[0.18em] text-farm-gold">Trovara OS</p>
            <h3 class="mt-2 text-3xl font-black">{{ copy.basicsTitle }}</h3>
            <ol class="mt-7 space-y-4">
              <li v-for="(item, index) in copy.basics" :key="item" class="flex gap-4 rounded-2xl border border-[color:var(--os-border)] p-5">
                <span class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-farm-green/15 font-black text-farm-green">{{ index + 1 }}</span>
                <span class="text-sm font-semibold leading-6">{{ item }}</span>
              </li>
            </ol>
          </template>

          <template v-else>
            <div class="py-4 text-center sm:py-8">
              <div class="mx-auto grid h-16 w-16 place-items-center rounded-3xl bg-farm-green/15 text-farm-green">
                <svg class="h-9 w-9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
              </div>
              <h3 class="mt-5 text-3xl font-black">{{ copy.readyTitle }}</h3>
              <p class="mx-auto mt-4 max-w-xl text-sm leading-7 text-os-fg-muted">{{ copy.readyBody }}</p>
              <div class="mx-auto mt-6 inline-flex items-center gap-2 rounded-full border border-farm-gold/30 bg-farm-gold/10 px-4 py-2 text-sm font-bold text-farm-gold">
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9.7 18h4.6M10 22h4m-7.6-8.8A7 7 0 1117.6 8c0 2.1-.9 3.5-2.3 4.9-.8.8-1.3 1.5-1.3 2.6h-4c0-1.1-.5-1.8-1.3-2.6a7.8 7.8 0 01-2.3-4.9" /></svg>
                {{ copy.help }}
              </div>
            </div>
          </template>
        </div>

        <footer class="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--os-border)] px-5 py-4 sm:px-7">
          <template v-if="mode === 'page'">
            <button type="button" class="min-h-11 rounded-xl border border-[color:var(--os-border)] px-5 text-sm font-bold hover:bg-white/5" @click="showFullGuide">
              {{ copy.fullGuide }}
            </button>
            <button type="button" class="min-h-11 rounded-xl bg-farm-green px-6 text-sm font-black text-white hover:brightness-110" @click="open = false">
              {{ copy.close }}
            </button>
          </template>
          <template v-else>
            <button v-if="step === 0" type="button" class="min-h-11 px-2 text-sm font-bold text-slate-400 hover:text-white" @click="closeAndRemember">
              {{ copy.skip }}
            </button>
            <button v-else type="button" class="min-h-11 rounded-xl border border-[color:var(--os-border)] px-5 text-sm font-bold hover:bg-white/5" @click="previousStep">
              {{ copy.back }}
            </button>
            <button type="button" class="min-h-11 rounded-xl bg-farm-green px-6 text-sm font-black text-white hover:brightness-110" @click="nextStep">
              {{ step === TOTAL_STEPS - 1 ? copy.finish : step === 0 ? copy.start : copy.next }}
            </button>
          </template>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
