<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'
import { uploadBrandAsset, type BrandAssetDto } from '@/lib/brand-upload'
import { resolveMediaUrl } from '@/lib/api'

type BrandAsset = BrandAssetDto

type BrandPack = {
  id: string
  title: string
  notes: string | null
  shareToken: string
  shareUrl: string
  passwordRequired: boolean
  expiresAt: string | null
  revokedAt: string | null
  viewCount: number
  downloadCount: number
  assetIds: string[]
  createdAt: string
}

const loading = ref(true)
const { t, locale } = useI18n()
const uploading = ref(false)
const uploadProgress = ref<string | null>(null)
const replacingAssetId = ref<string | null>(null)
const savingPack = ref(false)
const error = ref<string | null>(null)
const message = ref<string | null>(null)
const assets = ref<BrandAsset[]>([])
const packs = ref<BrandPack[]>([])
const editingPackId = ref<string | null>(null)
/** Assets uploaded while composing a new pack — create mode hides the farm library. */
const sessionAssetIds = ref<string[]>([])
const clearPassword = ref(false)
const packFormSection = ref<HTMLElement | null>(null)
const actionIds = ref<Set<string>>(new Set())
const assetPage = ref(1)
const packPage = ref(1)
const PAGE_SIZE = 24
let pollTimer: ReturnType<typeof setInterval> | null = null

const packForm = ref({
  title: '',
  notes: '',
  password: '',
  expiresAt: '',
  assetIds: [] as string[],
})

const selectedAssetIds = computed(() => new Set(packForm.value.assetIds))
const isEditingPack = computed(() => Boolean(editingPackId.value))
const visibleAssets = computed(() => {
  if (isEditingPack.value) return assets.value
  const session = new Set(sessionAssetIds.value)
  return assets.value.filter((asset) => session.has(asset.id))
})
const readyAssets = computed(() => visibleAssets.value.filter((asset) => asset.status === 'ready'))
const assetPageCount = computed(() => Math.max(1, Math.ceil(visibleAssets.value.length / PAGE_SIZE)))
const packPageCount = computed(() => Math.max(1, Math.ceil(packs.value.length / PAGE_SIZE)))
const pagedAssets = computed(() =>
  visibleAssets.value.slice((assetPage.value - 1) * PAGE_SIZE, assetPage.value * PAGE_SIZE),
)
const pagedPacks = computed(() =>
  packs.value.slice((packPage.value - 1) * PAGE_SIZE, packPage.value * PAGE_SIZE),
)
const hasProcessing = computed(() =>
  visibleAssets.value.some(
    (asset) => asset.status === 'processing' || asset.status === 'uploading',
  ),
)

const ACCEPT =
  'image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime,video/*,.heic,.heif,.mov,.mp4'

async function load() {
  loading.value = true
  error.value = null
  try {
    const [assetData, packData] = await Promise.all([
      api<{ assets: BrandAsset[] }>('/api/brand/assets'),
      api<{ packs: BrandPack[] }>('/api/brand/packs'),
    ])
    assets.value = assetData.assets
    packs.value = packData.packs
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('brandKits.loadFailed')
  } finally {
    loading.value = false
  }
}

function toDatetimeLocalValue(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function onUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (!files.length) return
  uploading.value = true
  error.value = null
  message.value = null
  const uploadedIds: string[] = []
  try {
    let cursor = 0
    const workers = Array.from({ length: Math.min(3, files.length) }, async () => {
      while (cursor < files.length) {
        const index = cursor++
        const file = files[index]
        uploadProgress.value = t('brandKits.uploadProgress', {
          current: index + 1,
          total: files.length,
          name: file.name,
        })
      const asset = await uploadBrandAsset(file, {
        onProgress: (progress) => {
          uploadProgress.value = `${file.name}: ${progress.message}`
        },
      })
      uploadedIds.push(asset.id)
      sessionAssetIds.value = [...new Set([...sessionAssetIds.value, asset.id])]
      }
    })
    await Promise.all(workers)
    await load()
    const readyUploaded = uploadedIds.filter((id) =>
      assets.value.some((asset) => asset.id === id && asset.status === 'ready'),
    )
    packForm.value.assetIds = [...new Set([...packForm.value.assetIds, ...readyUploaded])]
    message.value =
      files.length === 1
        ? t('brandKits.uploadedOne')
        : t('brandKits.uploadedMany', { count: files.length })
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('brandKits.uploadFailed')
    await load()
  } finally {
    uploading.value = false
    uploadProgress.value = null
  }
}

async function onReplaceAsset(assetId: string, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const existing = assets.value.find((asset) => asset.id === assetId)
  if (existing && (existing.status === 'processing' || existing.status === 'uploading')) {
    error.value = 'Wait for processing to finish before replacing'
    return
  }
  replacingAssetId.value = assetId
  error.value = null
  message.value = null
  try {
    await uploadBrandAsset(file, {
      replaceAssetId: assetId,
      onProgress: (progress) => {
        uploadProgress.value = progress.message
      },
    })
    message.value = 'Asset file replaced'
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not replace asset'
    await load()
  } finally {
    replacingAssetId.value = null
    uploadProgress.value = null
  }
}

function toggleAsset(id: string) {
  const asset = assets.value.find((row) => row.id === id)
  if (!asset || asset.status !== 'ready') return
  const next = new Set(packForm.value.assetIds)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  packForm.value.assetIds = [...next]
}

function selectAllAssets() {
  packForm.value.assetIds = readyAssets.value.map((asset) => asset.id)
}

function clearAssetSelection() {
  packForm.value.assetIds = []
}

function resetPackForm() {
  editingPackId.value = null
  sessionAssetIds.value = []
  clearPassword.value = false
  packForm.value = {
    title: '',
    notes: '',
    password: '',
    expiresAt: '',
    assetIds: [],
  }
}

function startEditPack(pack: BrandPack) {
  editingPackId.value = pack.id
  sessionAssetIds.value = []
  clearPassword.value = false
  packForm.value = {
    title: pack.title,
    notes: pack.notes ?? '',
    password: '',
    expiresAt: toDatetimeLocalValue(pack.expiresAt),
    assetIds: [...pack.assetIds],
  }
  message.value = `${t('brandKits.editPack')}: ${pack.title}`
  error.value = null
  packFormSection.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function savePack() {
  savingPack.value = true
  error.value = null
  message.value = null
  try {
    const payload = {
      title: packForm.value.title,
      notes: packForm.value.notes || null,
      assetIds: packForm.value.assetIds,
      password: packForm.value.password || null,
      clearPassword: clearPassword.value || undefined,
      expiresAt: packForm.value.expiresAt
        ? new Date(packForm.value.expiresAt).toISOString()
        : null,
    }
    if (editingPackId.value) {
      await api(`/api/brand/packs/${editingPackId.value}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
      message.value = t('brandKits.packUpdated')
    } else {
      await api('/api/brand/packs', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      message.value = t('brandKits.packCreated')
    }
    resetPackForm()
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('brandKits.saveFailed')
  } finally {
    savingPack.value = false
  }
}

async function copyLink(url: string) {
  try {
    await navigator.clipboard.writeText(url)
    message.value = t('brandKits.copied')
  } catch {
    message.value = url
  }
}

async function revokePack(id: string) {
  if (!window.confirm(t('brandKits.revokeConfirm'))) return
  await runAction(`revoke:${id}`, async () => {
    await api(`/api/brand/packs/${id}/revoke`, { method: 'POST', body: '{}' })
    message.value = t('brandKits.revoked')
    if (editingPackId.value === id) resetPackForm()
    await load()
  })
}

async function regenerateToken(id: string) {
  if (!window.confirm(t('brandKits.regenerateConfirm'))) return
  await runAction(`token:${id}`, async () => {
    await api(`/api/brand/packs/${id}/regenerate-token`, { method: 'POST', body: '{}' })
    message.value = t('brandKits.linkGenerated')
    await load()
  })
}

async function deleteAsset(id: string) {
  if (!window.confirm(t('brandKits.deleteAssetConfirm'))) return
  await runAction(`asset:${id}`, async () => {
    await api(`/api/brand/assets/${id}`, { method: 'DELETE' })
    packForm.value.assetIds = packForm.value.assetIds.filter((assetId) => assetId !== id)
    sessionAssetIds.value = sessionAssetIds.value.filter((assetId) => assetId !== id)
    await load()
  })
}

async function deletePack(id: string) {
  if (!window.confirm(t('brandKits.deletePackConfirm'))) return
  await runAction(`pack:${id}`, async () => {
    await api(`/api/brand/packs/${id}`, { method: 'DELETE' })
    if (editingPackId.value === id) resetPackForm()
    await load()
  })
}

async function runAction(id: string, action: () => Promise<void>) {
  actionIds.value = new Set(actionIds.value).add(id)
  error.value = null
  message.value = null
  try {
    await action()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('brandKits.actionFailed')
  } finally {
    const next = new Set(actionIds.value)
    next.delete(id)
    actionIds.value = next
  }
}

function formatBytes(n: number | null) {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(seconds: number | null) {
  if (seconds == null) return null
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function cacheBust(url: string | null, asset: BrandAsset) {
  if (!url) return ''
  const stamp = asset.updatedAt || asset.createdAt
  return `${resolveMediaUrl(url)}?v=${encodeURIComponent(stamp)}`
}

function startPolling() {
  stopPolling()
  pollTimer = setInterval(async () => {
    if (!hasProcessing.value) return
    try {
      const assetData = await api<{ assets: BrandAsset[] }>('/api/brand/assets')
      assets.value = assetData.assets
      const newlyReady = assetData.assets
        .filter((asset) => asset.status === 'ready')
        .map((asset) => asset.id)
      // Keep selection; allow selecting newly ready ones that were just uploaded
      packForm.value.assetIds = packForm.value.assetIds.filter((id) =>
        assetData.assets.some((asset) => asset.id === id && asset.status === 'ready'),
      )
      void newlyReady
    } catch {
      /* ignore transient poll errors */
    }
  }, 3000)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

onMounted(async () => {
  await load()
  startPolling()
})
onUnmounted(stopPolling)
</script>

<template>
  <AppLayout>
    <section class="page">
      <header class="hero">
        <p class="eyebrow">{{ t('brandKits.eyebrow') }}</p>
        <h1>{{ t('brandKits.title') }}</h1>
        <p class="lede">{{ t('brandKits.subtitle') }}</p>
      </header>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="message" class="ok" role="status">{{ message }}</p>
      <p v-if="uploadProgress" class="muted" role="status">{{ uploadProgress }}</p>
      <p v-if="loading" class="muted" role="status" aria-live="polite">{{ t('brandKits.loading') }}</p>

      <template v-else>
        <section class="panel">
          <div class="panel-head">
            <h2>{{ isEditingPack ? t('brandKits.library') : t('brandKits.packMedia') }}</h2>
            <label class="btn">
              {{ uploading ? t('brandKits.uploading') : t('brandKits.upload') }}
              <input
                type="file"
                :accept="ACCEPT"
                multiple
                :disabled="uploading || !!replacingAssetId"
                hidden
                @change="onUpload"
              />
            </label>
          </div>
          <p class="muted">{{ t('brandKits.subtitle') }}</p>
          <p v-if="!visibleAssets.length" class="muted">{{ t('brandKits.noAssets') }}</p>
          <template v-else>
            <div class="library-actions">
              <button type="button" class="link" @click="selectAllAssets">{{ t('brandKits.selectAll') }}</button>
              <button
                type="button"
                class="link"
                :disabled="!packForm.assetIds.length"
                @click="clearAssetSelection"
              >
                {{ t('brandKits.clearSelection') }}
              </button>
            </div>
            <ul class="asset-grid">
              <li v-for="asset in pagedAssets" :key="asset.id" class="asset-card">
                <button
                  type="button"
                  class="thumb"
                  :class="{
                    selected: selectedAssetIds.has(asset.id),
                    disabled: asset.status !== 'ready',
                  }"
                  :title="asset.originalName"
                  :disabled="asset.status !== 'ready'"
                  :aria-pressed="selectedAssetIds.has(asset.id)"
                  @click="toggleAsset(asset.id)"
                >
                  <span v-if="asset.status === 'processing' || asset.status === 'uploading'" class="badge">
                    {{ t('brandKits.processing') }}
                  </span>
                  <span v-else-if="asset.status === 'failed'" class="badge fail">{{ t('brandKits.failed') }}</span>
                  <template v-else-if="asset.mediaKind === 'video'">
                    <video
                      muted
                      playsinline
                      preload="none"
                      :poster="cacheBust(asset.posterUrl, asset) || undefined"
                      :src="cacheBust(asset.previewUrl, asset)"
                    />
                    <span v-if="formatDuration(asset.durationSeconds)" class="duration">
                      {{ formatDuration(asset.durationSeconds) }}
                    </span>
                  </template>
                  <img
                    v-else-if="asset.previewUrl"
                    :src="cacheBust(asset.previewUrl, asset)"
                    :alt="asset.originalName"
                  />
                </button>
                <div class="meta">
                  <strong>{{ asset.originalName }}</strong>
                  <span>
                    {{ asset.mediaKind }} · {{ formatBytes(asset.byteSize) }}
                  </span>
                  <span v-if="asset.processingError" class="fail-text">{{ asset.processingError }}</span>
                </div>
                <div class="asset-actions">
                  <label class="link">
                    {{ replacingAssetId === asset.id ? t('brandKits.replacing') : t('brandKits.replace') }}
                    <input
                      type="file"
                      :accept="
                        asset.mediaKind === 'video'
                          ? 'video/mp4,video/quicktime,video/*,.mov,.mp4'
                          : 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif'
                      "
                      :disabled="
                        !!replacingAssetId ||
                        uploading ||
                        asset.status === 'processing' ||
                        asset.status === 'uploading'
                      "
                      hidden
                      @change="onReplaceAsset(asset.id, $event)"
                    />
                  </label>
                  <button type="button" class="link danger" :disabled="actionIds.has(`asset:${asset.id}`)" @click="deleteAsset(asset.id)">{{ t('brandKits.delete') }}</button>
                </div>
              </li>
            </ul>
            <div v-if="assetPageCount > 1" class="pagination">
              <button type="button" class="link" :disabled="assetPage === 1" @click="assetPage--">{{ t('brandKits.previous') }}</button>
              <span>{{ t('brandKits.page', { current: assetPage, total: assetPageCount }) }}</span>
              <button type="button" class="link" :disabled="assetPage === assetPageCount" @click="assetPage++">{{ t('brandKits.next') }}</button>
            </div>
          </template>
        </section>

        <section ref="packFormSection" class="panel">
          <div class="panel-head">
            <h2>{{ isEditingPack ? t('brandKits.editPack') : t('brandKits.newPack') }}</h2>
            <button v-if="isEditingPack" type="button" class="link" @click="resetPackForm">
              {{ t('brandKits.cancelEdit') }}
            </button>
          </div>
          <p class="muted">{{ t('brandKits.subtitle') }}</p>
          <form class="form" @submit.prevent="savePack">
            <label>
              {{ t('brandKits.titleLabel') }}
              <input
                v-model="packForm.title"
                required
                maxlength="160"
                :placeholder="t('brandKits.titleLabel')"
              />
            </label>
            <label>
              {{ t('brandKits.notesLabel') }}
              <textarea
                v-model="packForm.notes"
                rows="2"
                maxlength="2000"
                :placeholder="t('brandKits.notesLabel')"
              />
            </label>
            <label>
              {{ isEditingPack ? t('brandKits.newPassword') : t('brandKits.password') }}
              <input
                v-model="packForm.password"
                type="password"
                maxlength="128"
                autocomplete="new-password"
                :disabled="clearPassword"
              />
            </label>
            <label v-if="isEditingPack" class="check">
              <input v-model="clearPassword" type="checkbox" />
              {{ t('brandKits.removePassword') }}
            </label>
            <label>
              {{ t('brandKits.expires') }}
              <input v-model="packForm.expiresAt" type="datetime-local" />
            </label>
            <p class="muted">{{ t('brandKits.selectedCount', { count: packForm.assetIds.length }) }}</p>
            <button
              type="submit"
              class="btn primary"
              :disabled="savingPack || !packForm.title.trim() || packForm.assetIds.length === 0"
            >
              {{
                savingPack
                  ? t('brandKits.saving')
                  : isEditingPack
                    ? t('brandKits.saveChanges')
                    : t('brandKits.createPack')
              }}
            </button>
          </form>
        </section>

        <section class="panel">
          <h2>{{ t('brandKits.packs') }}</h2>
          <p v-if="!packs.length" class="muted">{{ t('brandKits.noPacks') }}</p>
          <ul v-else class="pack-list">
            <li v-for="pack in pagedPacks" :key="pack.id" class="pack-card">
              <div class="pack-top">
                <div>
                  <h3>{{ pack.title }}</h3>
                  <p class="muted">
                    {{ t('brandKits.statusSummary', { files: pack.assetIds.length, views: pack.viewCount, downloads: pack.downloadCount }) }}
                    <template v-if="pack.passwordRequired"> · {{ t('brandKits.passwordProtected') }}</template>
                    <template v-if="pack.expiresAt">
                      · {{ t('brandKits.expiresAt', { date: new Date(pack.expiresAt).toLocaleString(locale) }) }}
                    </template>
                    <template v-if="pack.revokedAt"> · {{ t('brandKits.revokedStatus') }}</template>
                  </p>
                </div>
                <div class="actions">
                  <button type="button" class="link" @click="startEditPack(pack)">{{ t('brandKits.edit') }}</button>
                  <button
                    type="button"
                    class="link"
                    :disabled="!!pack.revokedAt"
                    @click="copyLink(pack.shareUrl)"
                  >
                    {{ t('brandKits.copyLink') }}
                  </button>
                  <button
                    type="button"
                    class="link"
                    :disabled="!!pack.revokedAt"
                    @click="regenerateToken(pack.id)"
                  >
                    {{ t('brandKits.newLink') }}
                  </button>
                  <button
                    type="button"
                    class="link"
                    :disabled="!!pack.revokedAt"
                    @click="revokePack(pack.id)"
                  >
                    {{ t('brandKits.revoke') }}
                  </button>
                  <button type="button" class="link danger" :disabled="actionIds.has(`pack:${pack.id}`)" @click="deletePack(pack.id)">{{ t('brandKits.delete') }}</button>
                </div>
              </div>
              <code class="share-url">{{ pack.shareUrl }}</code>
            </li>
          </ul>
          <div v-if="packPageCount > 1" class="pagination">
            <button type="button" class="link" :disabled="packPage === 1" @click="packPage--">{{ t('brandKits.previous') }}</button>
            <span>{{ t('brandKits.page', { current: packPage, total: packPageCount }) }}</span>
            <button type="button" class="link" :disabled="packPage === packPageCount" @click="packPage++">{{ t('brandKits.next') }}</button>
          </div>
        </section>
      </template>
    </section>
  </AppLayout>
</template>

<style scoped>
.page {
  max-width: 960px;
  margin: 0 auto;
  padding: 1.5rem 1rem 3rem;
  display: grid;
  gap: 1.5rem;
}
.hero h1 {
  margin: 0.2rem 0;
  font-size: 1.75rem;
}
.eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.75rem;
  opacity: 0.7;
  margin: 0;
}
.lede {
  margin: 0;
  max-width: 42rem;
  opacity: 0.85;
}
.panel {
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  border-radius: 12px;
  padding: 1rem 1.1rem 1.2rem;
  display: grid;
  gap: 0.85rem;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}
.library-actions,
.asset-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.85rem;
}
.panel h2 {
  margin: 0;
  font-size: 1.1rem;
}
.muted {
  opacity: 0.7;
  margin: 0;
}
.error {
  color: #b42318;
  margin: 0;
}
.ok {
  color: #027a48;
  margin: 0;
}
.fail-text {
  color: #b42318;
  font-size: 0.75rem;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.55rem 0.9rem;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  background: color-mix(in srgb, currentColor 6%, transparent);
  cursor: pointer;
  font: inherit;
}
.btn.primary {
  background: #1f6b3a;
  border-color: #1f6b3a;
  color: #fff;
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.form {
  display: grid;
  gap: 0.75rem;
}
.form label {
  display: grid;
  gap: 0.35rem;
  font-size: 0.9rem;
}
.form label.check {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.form input,
.form textarea {
  font: inherit;
  padding: 0.55rem 0.65rem;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  background: transparent;
  color: inherit;
}
.asset-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 0.85rem;
}
.asset-card {
  display: grid;
  gap: 0.4rem;
}
.thumb {
  position: relative;
  aspect-ratio: 1;
  border-radius: 10px;
  overflow: hidden;
  border: 2px solid transparent;
  padding: 0;
  background: color-mix(in srgb, currentColor 8%, transparent);
  cursor: pointer;
}
.thumb.selected {
  border-color: #1f6b3a;
}
.thumb.disabled {
  cursor: default;
  opacity: 0.85;
}
.thumb img,
.thumb video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.badge {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, #0f172a 70%, transparent);
  color: #fff;
  font-size: 0.8rem;
  font-weight: 700;
  z-index: 1;
}
.badge.fail {
  background: color-mix(in srgb, #b42318 80%, transparent);
}
.duration {
  position: absolute;
  right: 0.4rem;
  bottom: 0.4rem;
  background: color-mix(in srgb, #0f172a 75%, transparent);
  color: #fff;
  font-size: 0.7rem;
  padding: 0.15rem 0.35rem;
  border-radius: 4px;
}
.meta {
  display: grid;
  gap: 0.1rem;
  font-size: 0.8rem;
}
.meta strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pack-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.85rem;
}
.pack-card {
  border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  border-radius: 10px;
  padding: 0.85rem;
  display: grid;
  gap: 0.55rem;
}
.pack-top {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.pack-top h3 {
  margin: 0 0 0.25rem;
  font-size: 1rem;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.65rem;
  align-items: start;
}
.link {
  background: none;
  border: none;
  padding: 0;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
  font: inherit;
}
.link.danger {
  color: #b42318;
}
.share-url {
  display: block;
  font-size: 0.78rem;
  overflow-wrap: anywhere;
  opacity: 0.85;
}
</style>
