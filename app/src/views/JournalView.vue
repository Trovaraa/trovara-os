<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import JournalRichTextEditor from '@/components/JournalRichTextEditor.vue'
import { api } from '@/lib/api'
import { prepareJournalCoverDataUrl } from '@/lib/journal-cover'

type JournalPost = {
  id: string
  slug: string
  title: string
  excerpt: string
  bodyMarkdown: string
  authorName: string
  category: string
  tags: string[]
  coverImageUrl: string | null
  published: boolean
  publishedAt: string | null
  createdAt: string
  updatedAt: string
}

type JournalForm = {
  title: string
  slug: string
  excerpt: string
  bodyMarkdown: string
  authorName: string
  category: string
  tags: string
  coverImageUrl: string | null
}

const { t, locale } = useI18n()
const posts = ref<JournalPost[]>([])
const selectedPost = ref<JournalPost | null>(null)
const loading = ref(true)
const loadingPost = ref(false)
const saving = ref(false)
const uploading = ref(false)
const deleting = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const slugEdited = ref(false)

const form = reactive<JournalForm>({
  title: '',
  slug: '',
  excerpt: '',
  bodyMarkdown: '',
  authorName: 'Trovara Farm',
  category: 'Farm Stories',
  tags: '',
  coverImageUrl: null,
})

const isValid = computed(
  () =>
    Boolean(form.title.trim()) &&
    Boolean(slugify(form.slug)) &&
    Boolean(form.excerpt.trim()) &&
    Boolean(form.bodyMarkdown.trim()) &&
    Boolean(form.authorName.trim()) &&
    Boolean(form.category.trim()),
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
    if (!slugEdited.value) form.slug = slugify(title)
  },
)

function clearMessages() {
  error.value = null
  notice.value = null
}

function populateForm(post: JournalPost) {
  selectedPost.value = post
  form.title = post.title
  form.slug = post.slug
  form.excerpt = post.excerpt
  form.bodyMarkdown = post.bodyMarkdown
  form.authorName = post.authorName
  form.category = post.category
  form.tags = post.tags.join(', ')
  form.coverImageUrl = post.coverImageUrl
  slugEdited.value = true
}

function startNewPost() {
  selectedPost.value = null
  Object.assign(form, {
    title: '',
    slug: '',
    excerpt: '',
    bodyMarkdown: '',
    authorName: 'Trovara Farm',
    category: 'Farm Stories',
    tags: '',
    coverImageUrl: null,
  })
  slugEdited.value = false
  clearMessages()
}

async function loadPosts() {
  loading.value = true
  error.value = null
  try {
    const data = await api<{ posts: JournalPost[] }>('/api/journal')
    posts.value = data.posts ?? []
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('journal.loadFailed')
  } finally {
    loading.value = false
  }
}

async function selectPost(post: JournalPost) {
  clearMessages()
  populateForm(post)
  loadingPost.value = true
  try {
    const data = await api<{ post: JournalPost }>(`/api/journal/${post.id}`)
    if (selectedPost.value?.id === post.id) populateForm(data.post)
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('journal.loadPostFailed')
  } finally {
    loadingPost.value = false
  }
}

function payload() {
  return {
    title: form.title.trim(),
    slug: slugify(form.slug),
    excerpt: form.excerpt.trim(),
    bodyMarkdown: form.bodyMarkdown.trim(),
    authorName: form.authorName.trim(),
    category: form.category.trim(),
    tags: form.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
    coverImageUrl: form.coverImageUrl,
  }
}

function replacePost(post: JournalPost) {
  const index = posts.value.findIndex((item) => item.id === post.id)
  if (index >= 0) posts.value.splice(index, 1, post)
  else posts.value.unshift(post)
}

async function savePost(published?: boolean) {
  if (!isValid.value || saving.value) return
  saving.value = true
  clearMessages()
  try {
    let post: JournalPost
    if (selectedPost.value) {
      const data = await api<{ post: JournalPost }>(`/api/journal/${selectedPost.value.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...payload(),
          ...(typeof published === 'boolean' ? { published } : {}),
        }),
      })
      post = data.post
    } else {
      const created = await api<{ post: JournalPost }>('/api/journal', {
        method: 'POST',
        body: JSON.stringify(payload()),
      })
      post = created.post
      if (published === true) {
        const publishedResult = await api<{ post: JournalPost }>(`/api/journal/${post.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ published: true }),
        })
        post = publishedResult.post
      }
    }
    replacePost(post)
    populateForm(post)
    notice.value =
      published === true
        ? t('journal.publishedNotice')
        : published === false
          ? t('journal.unpublishedNotice')
          : t('journal.savedNotice')
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('journal.saveFailed')
  } finally {
    saving.value = false
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error(t('journal.imageReadFailed')))
    reader.onerror = () => reject(new Error(t('journal.imageReadFailed')))
    reader.readAsDataURL(file)
  })
}

function mapCoverPrepareError(code: string): string {
  if (code === 'UNSUPPORTED_IMAGE') return t('journal.imageUnsupported')
  if (code === 'IMAGE_TOO_LARGE') return t('journal.imageTooLarge')
  if (code === 'COMPRESS_FAILED') return t('journal.imageCompressFailed')
  return t('journal.uploadFailed')
}

/** Prefer public media URLs (nginx ^~ /public/). /api/…/*.jpg can hit a static-asset regex. */
function coverDisplaySrc(url: string | null | undefined): string | null {
  if (!url) return null
  if (url.startsWith('data:') || url.startsWith('blob:')) return url
  return url
}

function validCoverUrlShape(value: string): boolean {
  return /^\/public\/journal\/media\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{20,64}\.(?:jpg|png|webp)$/i.test(
    value,
  )
}

async function uploadCover(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const previousUrl = form.coverImageUrl
  uploading.value = true
  clearMessages()
  try {
    // Hard stop before we try to load multi‑dozen‑MB camera dumps into memory.
    if (file.size > 25 * 1024 * 1024) {
      throw new Error(t('journal.imageTooLarge'))
    }

    let dataUrl: string
    try {
      dataUrl = await prepareJournalCoverDataUrl(file)
    } catch (prepareError) {
      const code = prepareError instanceof Error ? prepareError.message : ''
      const compatible =
        /^image\/(jpeg|png|webp)$/i.test(file.type) && file.size <= 1.5 * 1024 * 1024
      // Only fall back for already-small JPEG/PNG/WebP if canvas compression fails.
      if (code === 'COMPRESS_FAILED' && compatible) {
        dataUrl = await readFileAsDataUrl(file)
      } else {
        throw new Error(mapCoverPrepareError(code || 'COMPRESS_FAILED'))
      }
    }
    form.coverImageUrl = dataUrl
    const data = await api<{ url: string }>('/api/journal/media', {
      method: 'POST',
      body: JSON.stringify({ dataUrl }),
    })
    if (!data.url || !validCoverUrlShape(data.url)) {
      throw new Error(t('journal.uploadFailed'))
    }
    // Prefer authenticated preview; keep the uploaded URL even if preview probe fails.
    const preview = coverDisplaySrc(data.url)
    if (preview && !preview.startsWith('data:')) {
      try {
        const probe = await fetch(preview, { credentials: 'include', method: 'GET' })
        if (!probe.ok) {
          console.warn('Journal cover preview probe failed', probe.status)
        }
      } catch {
        console.warn('Journal cover preview probe failed')
      }
    }
    form.coverImageUrl = data.url
    notice.value = t('journal.imageUploaded')
  } catch (e) {
    form.coverImageUrl = previousUrl
    error.value = e instanceof Error ? e.message : t('journal.uploadFailed')
  } finally {
    uploading.value = false
    input.value = ''
  }
}

async function deletePost() {
  const post = selectedPost.value
  if (!post || deleting.value || !window.confirm(t('journal.deleteConfirm', { title: post.title }))) {
    return
  }
  deleting.value = true
  clearMessages()
  try {
    await api(`/api/journal/${post.id}`, { method: 'DELETE' })
    posts.value = posts.value.filter((item) => item.id !== post.id)
    startNewPost()
    notice.value = t('journal.deletedNotice')
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('journal.deleteFailed')
  } finally {
    deleting.value = false
  }
}

function formatDate(value: string | null): string {
  if (!value) return ''
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

onMounted(loadPosts)
</script>

<template>
  <AppLayout>
    <header class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p class="text-xs font-bold uppercase tracking-[0.2em] text-farm-green">
          {{ t('journal.eyebrow') }}
        </p>
        <h2 class="mt-1 text-2xl font-black text-os-fg">{{ t('journal.title') }}</h2>
        <p class="mt-1 max-w-2xl text-sm text-slate-400">{{ t('journal.subtitle') }}</p>
      </div>
      <button
        type="button"
        class="rounded-lg bg-farm-green px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-farm-green/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-farm-green"
        @click="startNewPost"
      >
        {{ t('journal.newPost') }}
      </button>
    </header>

    <div aria-live="polite" class="mt-4 min-h-5">
      <p v-if="error" role="alert" class="text-sm text-red-300">{{ error }}</p>
      <p v-else-if="notice" class="text-sm text-farm-green">{{ notice }}</p>
    </div>

    <div class="mt-4 grid min-w-0 gap-6 xl:grid-cols-[20rem_minmax(0,1fr)]">
      <aside class="min-w-0 rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
        <div class="flex items-center justify-between gap-3">
          <h3 class="font-bold text-white">{{ t('journal.posts') }}</h3>
          <button
            type="button"
            class="text-xs font-semibold text-slate-400 hover:text-white"
            :disabled="loading"
            @click="loadPosts"
          >
            {{ t('journal.refresh') }}
          </button>
        </div>
        <p v-if="loading" class="mt-6 text-sm text-slate-400">{{ t('journal.loading') }}</p>
        <ul v-else class="mt-4 space-y-2" :aria-label="t('journal.posts')">
          <li v-for="post in posts" :key="post.id">
            <button
              type="button"
              class="w-full rounded-xl border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-farm-green"
              :class="
                selectedPost?.id === post.id
                  ? 'border-farm-green/60 bg-farm-green/10'
                  : 'border-slate-800 bg-slate-950/50 hover:border-slate-700'
              "
              @click="selectPost(post)"
            >
              <span class="block truncate text-sm font-semibold text-white">{{ post.title }}</span>
              <span class="mt-2 flex flex-wrap items-center justify-between gap-2">
                <span
                  class="rounded-full px-2 py-0.5 text-[11px] font-bold"
                  :class="
                    post.published
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : 'bg-amber-500/15 text-amber-300'
                  "
                >
                  {{ post.published ? t('journal.published') : t('journal.draft') }}
                </span>
                <span class="text-[11px] text-slate-500">{{ formatDate(post.updatedAt) }}</span>
              </span>
            </button>
          </li>
        </ul>
        <p v-if="!loading && !posts.length" class="mt-6 text-sm text-slate-500">
          {{ t('journal.noPosts') }}
        </p>
      </aside>

      <section class="min-w-0 rounded-2xl border border-slate-800 bg-slate-900/80 p-4 sm:p-6">
        <div class="border-b border-slate-800 pb-4">
          <div>
            <h3 class="font-bold text-white">
              {{ selectedPost ? t('journal.editPost') : t('journal.createPost') }}
            </h3>
            <p v-if="selectedPost" class="mt-1 text-xs text-slate-500">
              {{ t('journal.lastUpdated', { date: formatDate(selectedPost.updatedAt) }) }}
            </p>
            <p class="mt-1 text-xs text-slate-500">
              {{
                selectedPost?.publishedAt
                  ? t('journal.publishedOn', { date: formatDate(selectedPost.publishedAt) })
                  : t('journal.publishDateAutomatic')
              }}
            </p>
          </div>
        </div>

        <p v-if="loadingPost" class="mt-5 text-sm text-slate-400">{{ t('journal.loadingPost') }}</p>

        <form v-else class="mt-5 space-y-5" @submit.prevent="savePost()">
          <div class="grid gap-4 md:grid-cols-2">
            <label class="block text-sm font-semibold text-slate-300">
              {{ t('journal.postTitle') }}
              <span class="text-red-300" aria-hidden="true">*</span>
              <span class="sr-only">({{ t('journal.required') }})</span>
              <input
                v-model="form.title"
                required
                maxlength="180"
                :placeholder="t('journal.titlePlaceholder')"
                class="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white focus:border-farm-green focus:outline-none"
              />
            </label>
            <label class="block text-sm font-semibold text-slate-300">
              {{ t('journal.slug') }}
              <span class="text-red-300" aria-hidden="true">*</span>
              <span class="sr-only">({{ t('journal.required') }})</span>
              <input
                v-model="form.slug"
                required
                maxlength="180"
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                :title="t('journal.slugHint')"
                :placeholder="t('journal.slugPlaceholder')"
                class="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 font-mono text-sm text-white focus:border-farm-green focus:outline-none"
                @input="slugEdited = true"
                @blur="form.slug = slugify(form.slug)"
              />
            </label>
          </div>

          <label class="block text-sm font-semibold text-slate-300">
            {{ t('journal.excerpt') }}
            <span class="text-red-300" aria-hidden="true">*</span>
            <span class="sr-only">({{ t('journal.required') }})</span>
            <textarea
              v-model="form.excerpt"
              required
              rows="3"
              maxlength="500"
              :placeholder="t('journal.excerptPlaceholder')"
              class="mt-1.5 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white focus:border-farm-green focus:outline-none"
            />
          </label>

          <div class="grid gap-4 md:grid-cols-2">
            <label class="block text-sm font-semibold text-slate-300">
              {{ t('journal.author') }}
              <span class="text-red-300" aria-hidden="true">*</span>
              <span class="sr-only">({{ t('journal.required') }})</span>
              <input
                v-model="form.authorName"
                required
                maxlength="120"
                :placeholder="t('journal.authorPlaceholder')"
                class="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white focus:border-farm-green focus:outline-none"
              />
            </label>
            <label class="block text-sm font-semibold text-slate-300">
              {{ t('journal.category') }}
              <span class="text-red-300" aria-hidden="true">*</span>
              <span class="sr-only">({{ t('journal.required') }})</span>
              <input
                v-model="form.category"
                required
                maxlength="80"
                :placeholder="t('journal.categoryPlaceholder')"
                class="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white focus:border-farm-green focus:outline-none"
              />
            </label>
          </div>

          <label class="block text-sm font-semibold text-slate-300">
            {{ t('journal.tags') }}
            <span class="font-normal text-slate-500">({{ t('journal.optional') }})</span>
            <input
              v-model="form.tags"
              :placeholder="t('journal.tagsPlaceholder')"
              class="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white focus:border-farm-green focus:outline-none"
            />
            <span class="mt-1 block text-xs font-normal text-slate-500">{{ t('journal.tagsHint') }}</span>
          </label>

          <div>
            <label for="journal-cover" class="block text-sm font-semibold text-slate-300">
              {{ t('journal.coverImage') }}
              <span class="font-normal text-slate-500">({{ t('journal.optional') }})</span>
            </label>
            <input
              id="journal-cover"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/*"
              class="mt-1.5 block w-full text-sm text-slate-400 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-700 file:px-3 file:py-2 file:font-semibold file:text-white hover:file:bg-slate-600"
              :disabled="uploading"
              @change="uploadCover"
            />
            <p class="mt-2 text-xs font-normal text-slate-500">{{ t('journal.coverHint') }}</p>
            <p v-if="uploading" class="mt-2 text-xs text-slate-400">{{ t('journal.uploading') }}</p>
            <img
              v-if="coverDisplaySrc(form.coverImageUrl)"
              :src="coverDisplaySrc(form.coverImageUrl)!"
              :alt="t('journal.coverPreviewAlt')"
              class="mt-3 max-h-64 w-full rounded-xl border border-slate-800 object-cover"
            />
          </div>

          <div>
            <p class="block text-sm font-semibold text-slate-300">
              {{ t('journal.body') }}
              <span class="text-red-300" aria-hidden="true">*</span>
              <span class="sr-only">({{ t('journal.required') }})</span>
            </p>
            <p class="mb-2 mt-1 text-xs font-normal text-slate-500">
              {{ t('journal.bodyHint') }}
            </p>
            <JournalRichTextEditor
              v-model="form.bodyMarkdown"
              :label="t('journal.body')"
              :placeholder="t('journal.bodyPlaceholder')"
              :visual-label="t('journal.visualEditor')"
              :markdown-label="t('journal.markdownSource')"
            />
          </div>

          <div class="flex flex-wrap items-center gap-3 border-t border-slate-800 pt-5">
            <button
              type="submit"
              class="rounded-lg bg-farm-green px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-farm-green/90 disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="!isValid || saving || uploading"
            >
              {{
                saving
                  ? t('journal.saving')
                  : selectedPost
                    ? t('journal.saveChanges')
                    : t('journal.saveDraft')
              }}
            </button>
            <button
              v-if="!selectedPost?.published"
              type="button"
              class="rounded-lg border border-emerald-500/50 px-4 py-2.5 text-sm font-bold text-emerald-300 hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="!isValid || saving || uploading"
              @click="savePost(true)"
            >
              {{ t('journal.publish') }}
            </button>
            <button
              v-else
              type="button"
              class="rounded-lg border border-amber-500/50 px-4 py-2.5 text-sm font-bold text-amber-300 hover:bg-amber-500/10 disabled:opacity-40"
              :disabled="saving"
              @click="savePost(false)"
            >
              {{ t('journal.unpublish') }}
            </button>
            <button
              v-if="selectedPost"
              type="button"
              class="ml-auto rounded-lg px-4 py-2.5 text-sm font-bold text-red-300 hover:bg-red-500/10 disabled:opacity-40"
              :disabled="deleting || saving"
              @click="deletePost"
            >
              {{ deleting ? t('journal.deleting') : t('journal.delete') }}
            </button>
          </div>
        </form>
      </section>
    </div>
  </AppLayout>
</template>
