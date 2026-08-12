<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

type CareerPost = {
  id: string
  slug: string
  title: string
  department: string | null
  location: string | null
  employmentType: string
  engagementDetails: string | null
  projectName: string | null
  duration: string | null
  applicationDeadline: string | null
  expectedStartDate: string | null
  summary: string
  bodyMarkdown: string
  applyEmail: string
  applySubject: string | null
  applicationInstructions: string | null
  published: boolean
  publishedAt: string | null
  createdAt: string
  updatedAt: string
}

type CareerForm = {
  title: string
  slug: string
  department: string
  location: string
  employmentType: string
  engagementDetails: string
  projectName: string
  duration: string
  applicationDeadline: string
  expectedStartDate: string
  summary: string
  bodyMarkdown: string
  applyEmail: string
  applySubject: string
  applicationInstructions: string
}

const EMPLOYMENT_TYPES = [
  'full_time',
  'part_time',
  'contract',
  'internship',
  'temporary',
  'consultancy',
  'graduate_placement',
] as const

const { t } = useI18n()
const posts = ref<CareerPost[]>([])
const selectedId = ref<string | null>(null)
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const slugEdited = ref(false)

const form = reactive<CareerForm>({
  title: '',
  slug: '',
  department: '',
  location: 'Abeokuta, Nigeria',
  employmentType: 'full_time',
  engagementDetails: '',
  projectName: '',
  duration: '',
  applicationDeadline: '',
  expectedStartDate: '',
  summary: '',
  bodyMarkdown: '',
  applyEmail: 'hello@trovara.farm',
  applySubject: '',
  applicationInstructions: '',
})

const selected = computed(() => posts.value.find((post) => post.id === selectedId.value) ?? null)
const isValid = computed(
  () =>
    Boolean(form.title.trim()) &&
    Boolean(slugify(form.slug)) &&
    Boolean(form.summary.trim()) &&
    Boolean(form.bodyMarkdown.trim()) &&
    Boolean(form.applyEmail.trim()),
)

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

watch(
  () => form.title,
  (title) => {
    if (!slugEdited.value && !selectedId.value) form.slug = slugify(title)
  },
)

function resetForm() {
  selectedId.value = null
  slugEdited.value = false
  form.title = ''
  form.slug = ''
  form.department = ''
  form.location = 'Abeokuta, Nigeria'
  form.employmentType = 'full_time'
  form.engagementDetails = ''
  form.projectName = ''
  form.duration = ''
  form.applicationDeadline = ''
  form.expectedStartDate = ''
  form.summary = ''
  form.bodyMarkdown = ''
  form.applyEmail = 'hello@trovara.farm'
  form.applySubject = ''
  form.applicationInstructions = ''
}

function editPost(post: CareerPost) {
  selectedId.value = post.id
  slugEdited.value = true
  form.title = post.title
  form.slug = post.slug
  form.department = post.department ?? ''
  form.location = post.location ?? ''
  form.employmentType = post.employmentType
  form.engagementDetails = post.engagementDetails ?? ''
  form.projectName = post.projectName ?? ''
  form.duration = post.duration ?? ''
  form.applicationDeadline = post.applicationDeadline ?? ''
  form.expectedStartDate = post.expectedStartDate ?? ''
  form.summary = post.summary
  form.bodyMarkdown = post.bodyMarkdown
  form.applyEmail = post.applyEmail
  form.applySubject = post.applySubject ?? ''
  form.applicationInstructions = post.applicationInstructions ?? ''
  notice.value = null
  error.value = null
}

async function load() {
  loading.value = true
  error.value = null
  try {
    const data = await api<{ posts: CareerPost[] }>('/api/careers')
    posts.value = data.posts
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('careers.loadFailed')
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!isValid.value) return
  saving.value = true
  error.value = null
  notice.value = null
  try {
    const payload = {
      title: form.title.trim(),
      slug: slugify(form.slug),
      department: form.department.trim() || null,
      location: form.location.trim() || null,
      employmentType: form.employmentType,
      engagementDetails: form.engagementDetails.trim() || null,
      projectName: form.projectName.trim() || null,
      duration: form.duration.trim() || null,
      applicationDeadline: form.applicationDeadline || null,
      expectedStartDate: form.expectedStartDate || null,
      summary: form.summary.trim(),
      bodyMarkdown: form.bodyMarkdown.trim(),
      applyEmail: form.applyEmail.trim(),
      applySubject: form.applySubject.trim() || null,
      applicationInstructions: form.applicationInstructions.trim() || null,
    }
    if (selectedId.value) {
      await api(`/api/careers/${selectedId.value}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
      notice.value = t('careers.saved')
    } else {
      const created = await api<{ post: CareerPost }>('/api/careers', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      selectedId.value = created.post.id
      notice.value = t('careers.created')
    }
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('careers.saveFailed')
  } finally {
    saving.value = false
  }
}

async function setPublished(published: boolean) {
  if (!selectedId.value) return
  saving.value = true
  error.value = null
  try {
    await api(`/api/careers/${selectedId.value}`, {
      method: 'PATCH',
      body: JSON.stringify({ published }),
    })
    notice.value = published ? t('careers.published') : t('careers.unpublished')
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('careers.saveFailed')
  } finally {
    saving.value = false
  }
}

async function removePost() {
  if (!selectedId.value) return
  if (!confirm(t('careers.confirmDelete'))) return
  saving.value = true
  try {
    await api(`/api/careers/${selectedId.value}`, { method: 'DELETE' })
    resetForm()
    notice.value = t('careers.deleted')
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('careers.saveFailed')
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <AppLayout>
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h2 class="text-2xl font-black text-os-fg">{{ t('careers.title') }}</h2>
        <p class="text-slate-400 text-sm mt-1">{{ t('careers.subtitle') }}</p>
      </div>
      <button
        type="button"
        class="rounded-xl bg-farm-green px-4 py-2 text-sm font-bold text-white"
        @click="resetForm"
      >
        {{ t('careers.newPost') }}
      </button>
    </div>

    <p v-if="error" class="mt-4 text-sm text-red-400">{{ error }}</p>
    <p v-if="notice" class="mt-4 text-sm text-farm-green">{{ notice }}</p>

    <div class="mt-6 grid grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)] gap-6">
      <div class="rounded-2xl border border-slate-800 bg-slate-900 overflow-hidden">
        <div class="px-4 py-3 border-b border-slate-800 text-xs font-semibold text-slate-500 uppercase tracking-wide">
          {{ t('careers.listings') }}
        </div>
        <div v-if="loading" class="p-4 text-sm text-slate-500">{{ t('careers.loading') }}</div>
        <div v-else-if="!posts.length" class="p-4 text-sm text-slate-500">{{ t('careers.empty') }}</div>
        <button
          v-for="post in posts"
          :key="post.id"
          type="button"
          class="w-full text-left px-4 py-3 border-b border-slate-800/70 hover:bg-slate-800/50"
          :class="selectedId === post.id ? 'bg-slate-800/80' : ''"
          @click="editPost(post)"
        >
          <p class="font-semibold text-os-fg text-sm">{{ post.title }}</p>
          <p class="text-xs text-slate-500 mt-1">
            {{ post.published ? t('careers.status.published') : t('careers.status.draft') }}
            · {{ post.slug }}
          </p>
        </button>
      </div>

      <div class="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label class="text-sm text-slate-400 space-y-1 md:col-span-2">
            <span>{{ t('careers.fields.title') }}</span>
            <input v-model="form.title" type="text" class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100" />
          </label>
          <label class="text-sm text-slate-400 space-y-1">
            <span>{{ t('careers.fields.slug') }}</span>
            <input
              v-model="form.slug"
              type="text"
              class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100"
              @input="slugEdited = true"
            />
          </label>
          <label class="text-sm text-slate-400 space-y-1">
            <span>{{ t('careers.fields.employmentType') }}</span>
            <select v-model="form.employmentType" class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100">
              <option v-for="type in EMPLOYMENT_TYPES" :key="type" :value="type">
                {{ t(`careers.employment.${type}`) }}
              </option>
            </select>
          </label>
          <label class="text-sm text-slate-400 space-y-1">
            <span>{{ t('careers.fields.department') }}</span>
            <input v-model="form.department" type="text" class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100" />
          </label>
          <label class="text-sm text-slate-400 space-y-1">
            <span>{{ t('careers.fields.location') }}</span>
            <input v-model="form.location" type="text" class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100" />
          </label>
          <label class="text-sm text-slate-400 space-y-1">
            <span>{{ t('careers.fields.projectName') }}</span>
            <input v-model="form.projectName" type="text" class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100" />
          </label>
          <label class="text-sm text-slate-400 space-y-1">
            <span>{{ t('careers.fields.engagementDetails') }}</span>
            <input v-model="form.engagementDetails" type="text" class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100" />
          </label>
          <label class="text-sm text-slate-400 space-y-1">
            <span>{{ t('careers.fields.duration') }}</span>
            <input v-model="form.duration" type="text" class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100" />
          </label>
          <label class="text-sm text-slate-400 space-y-1">
            <span>{{ t('careers.fields.applicationDeadline') }}</span>
            <input v-model="form.applicationDeadline" type="date" class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100" />
          </label>
          <label class="text-sm text-slate-400 space-y-1">
            <span>{{ t('careers.fields.expectedStartDate') }}</span>
            <input v-model="form.expectedStartDate" type="date" class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100" />
          </label>
          <label class="text-sm text-slate-400 space-y-1 md:col-span-2">
            <span>{{ t('careers.fields.applyEmail') }}</span>
            <input v-model="form.applyEmail" type="email" class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100" />
          </label>
          <label class="text-sm text-slate-400 space-y-1 md:col-span-2">
            <span>{{ t('careers.fields.applySubject') }}</span>
            <input v-model="form.applySubject" type="text" class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100" />
          </label>
          <label class="text-sm text-slate-400 space-y-1 md:col-span-2">
            <span>{{ t('careers.fields.applicationInstructions') }}</span>
            <textarea v-model="form.applicationInstructions" rows="3" class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100" />
          </label>
          <label class="text-sm text-slate-400 space-y-1 md:col-span-2">
            <span>{{ t('careers.fields.summary') }}</span>
            <textarea v-model="form.summary" rows="2" class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100" />
          </label>
          <label class="text-sm text-slate-400 space-y-1 md:col-span-2">
            <span>{{ t('careers.fields.body') }}</span>
            <textarea v-model="form.bodyMarkdown" rows="12" class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100 font-mono text-xs" />
          </label>
        </div>

        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="rounded-xl bg-farm-green px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
            :disabled="saving || !isValid"
            @click="save"
          >
            {{ t('careers.save') }}
          </button>
          <button
            v-if="selected && !selected.published"
            type="button"
            class="rounded-xl border border-farm-green px-4 py-2 text-sm font-semibold text-farm-green disabled:opacity-50"
            :disabled="saving"
            @click="setPublished(true)"
          >
            {{ t('careers.publish') }}
          </button>
          <button
            v-if="selected?.published"
            type="button"
            class="rounded-xl border border-slate-600 px-4 py-2 text-sm text-slate-300 disabled:opacity-50"
            :disabled="saving"
            @click="setPublished(false)"
          >
            {{ t('careers.unpublish') }}
          </button>
          <button
            v-if="selected"
            type="button"
            class="rounded-xl border border-red-900/60 px-4 py-2 text-sm text-red-300 disabled:opacity-50"
            :disabled="saving"
            @click="removePost"
          >
            {{ t('careers.delete') }}
          </button>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
