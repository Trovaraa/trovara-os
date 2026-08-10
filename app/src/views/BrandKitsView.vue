<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'
import { uploadBrandAsset, type BrandAssetDto } from '@/lib/brand-upload'

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
const hasProcessing = computed(() =>
  visibleAssets.value.some(
    (asset) => asset.status === 'processing' || asset.status === 'uploading',
  ),
)

const ACCEPT =
  'image/jpeg,image/png,image/webp,image/svg+xml,image/heic,image/heif,video/mp4,video/quicktime,video/*,.heic,.heif,.mov,.mp4'

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
    error.value = e instanceof Error ? e.message : 'Failed to load brand kit'
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
    for (const [index, file] of files.entries()) {
      uploadProgress.value = `Uploading ${index + 1} of ${files.length}: ${file.name}`
      const asset = await uploadBrandAsset(file, {
        onProgress: (progress) => {
          uploadProgress.value = `${file.name}: ${progress.message}`
        },
      })
      uploadedIds.push(asset.id)
      sessionAssetIds.value = [...new Set([...sessionAssetIds.value, asset.id])]
      await load()
    }
    packForm.value.assetIds = [
      ...new Set([
        ...packForm.value.assetIds,
        ...uploadedIds.filter((id) =>
          assets.value.some((asset) => asset.id === id && asset.status === 'ready'),
        ),
      ]),
    ]
    // Also select any that finished ready after last load
    await load()
    const readyUploaded = uploadedIds.filter((id) =>
      assets.value.some((asset) => asset.id === id && asset.status === 'ready'),
    )
    packForm.value.assetIds = [...new Set([...packForm.value.assetIds, ...readyUploaded])]
    message.value =
      files.length === 1
        ? 'Asset uploaded and selected for this pack'
        : `${files.length} assets uploaded`
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Upload failed'
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
  message.value = `Editing “${pack.title}” — update fields or selection, then save`
  error.value = null
  window.scrollTo({ top: 0, behavior: 'smooth' })
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
      message.value = 'Pack updated'
    } else {
      await api('/api/brand/packs', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      message.value = 'Pack created — copy the share link below'
    }
    resetPackForm()
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not save pack'
  } finally {
    savingPack.value = false
  }
}

async function copyLink(url: string) {
  try {
    await navigator.clipboard.writeText(url)
    message.value = 'Share link copied'
  } catch {
    message.value = url
  }
}

async function revokePack(id: string) {
  if (!window.confirm('Revoke this pack? The share link will stop working.')) return
  await api(`/api/brand/packs/${id}/revoke`, { method: 'POST', body: '{}' })
  message.value = 'Pack revoked'
  if (editingPackId.value === id) resetPackForm()
  await load()
}

async function regenerateToken(id: string) {
  if (!window.confirm('Generate a new link? The old link will stop working.')) return
  await api(`/api/brand/packs/${id}/regenerate-token`, { method: 'POST', body: '{}' })
  message.value = 'New share link generated'
  await load()
}

async function deleteAsset(id: string) {
  if (!window.confirm('Delete this asset from the library?')) return
  await api(`/api/brand/assets/${id}`, { method: 'DELETE' })
  packForm.value.assetIds = packForm.value.assetIds.filter((assetId) => assetId !== id)
  sessionAssetIds.value = sessionAssetIds.value.filter((assetId) => assetId !== id)
  await load()
}

async function deletePack(id: string) {
  if (!window.confirm('Delete this pack permanently?')) return
  await api(`/api/brand/packs/${id}`, { method: 'DELETE' })
  if (editingPackId.value === id) resetPackForm()
  await load()
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
  return `${url}?v=${encodeURIComponent(stamp)}`
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
        <p class="eyebrow">Brand</p>
        <h1>Brand kit</h1>
        <p class="lede">
          Upload branded photos and videos (including iPhone HEIC/MOV), assemble press packs, and
          share an unlisted link with optional password. Videos are converted to H.264 MP4 at the
          original resolution.
        </p>
      </header>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="message" class="ok" role="status">{{ message }}</p>
      <p v-if="uploadProgress" class="muted" role="status">{{ uploadProgress }}</p>
      <p v-if="loading" class="muted">Loading…</p>

      <template v-else>
        <section class="panel">
          <div class="panel-head">
            <h2>{{ isEditingPack ? 'Library' : 'Pack media' }}</h2>
            <label class="btn">
              {{ uploading ? 'Uploading…' : 'Upload photos / video' }}
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
          <p v-if="isEditingPack" class="muted">
            Farm library — select assets for this pack, or upload more. Existing pack files stay
            available here while you edit.
          </p>
          <p v-else class="muted">
            Upload media for this new pack. The farm library (assets already used in other packs)
            only appears when you edit a pack.
          </p>
          <p v-if="!visibleAssets.length" class="muted">
            <template v-if="isEditingPack">
              No assets yet. Upload JPEG, PNG, WebP, SVG, HEIC, MP4, or MOV (max 500&nbsp;MB /
              10&nbsp;min).
            </template>
            <template v-else>
              Nothing selected yet. Upload JPEG, PNG, WebP, SVG, HEIC, MP4, or MOV (max 500&nbsp;MB
              / 10&nbsp;min).
            </template>
          </p>
          <template v-else>
            <div class="library-actions">
              <button type="button" class="link" @click="selectAllAssets">Select all ready</button>
              <button
                type="button"
                class="link"
                :disabled="!packForm.assetIds.length"
                @click="clearAssetSelection"
              >
                Clear selection
              </button>
            </div>
            <ul class="asset-grid">
              <li v-for="asset in visibleAssets" :key="asset.id" class="asset-card">
                <button
                  type="button"
                  class="thumb"
                  :class="{
                    selected: selectedAssetIds.has(asset.id),
                    disabled: asset.status !== 'ready',
                  }"
                  :title="asset.originalName"
                  :disabled="asset.status !== 'ready'"
                  @click="toggleAsset(asset.id)"
                >
                  <span v-if="asset.status === 'processing' || asset.status === 'uploading'" class="badge">
                    Processing…
                  </span>
                  <span v-else-if="asset.status === 'failed'" class="badge fail">Failed</span>
                  <template v-else-if="asset.mediaKind === 'video'">
                    <video
                      muted
                      playsinline
                      preload="metadata"
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
                    {{ replacingAssetId === asset.id ? 'Replacing…' : 'Replace' }}
                    <input
                      type="file"
                      :accept="
                        asset.mediaKind === 'video'
                          ? 'video/mp4,video/quicktime,video/*,.mov,.mp4'
                          : 'image/jpeg,image/png,image/webp,image/svg+xml,image/heic,image/heif,.heic,.heif'
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
                  <button type="button" class="link danger" @click="deleteAsset(asset.id)">Delete</button>
                </div>
              </li>
            </ul>
          </template>
        </section>

        <section class="panel">
          <div class="panel-head">
            <h2>{{ isEditingPack ? 'Edit pack' : 'New pack' }}</h2>
            <button v-if="isEditingPack" type="button" class="link" @click="resetPackForm">
              Cancel edit
            </button>
          </div>
          <p class="muted">
            <template v-if="isEditingPack">
              Click library thumbnails to add/remove, or upload more. Only ready assets can join a
              pack.
            </template>
            <template v-else>
              Upload media above (ready files are selected automatically). Only ready assets can
              join a pack.
            </template>
          </p>
          <form class="form" @submit.prevent="savePack">
            <label>
              Title
              <input
                v-model="packForm.title"
                required
                maxlength="160"
                placeholder="Creator press pack — Aug 2026"
              />
            </label>
            <label>
              Notes (shown on the share page)
              <textarea
                v-model="packForm.notes"
                rows="2"
                maxlength="2000"
                placeholder="Optional guidance for the recipient"
              />
            </label>
            <label>
              {{ isEditingPack ? 'New password (optional)' : 'Password (optional)' }}
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
              Remove existing password
            </label>
            <label>
              Expires (optional)
              <input v-model="packForm.expiresAt" type="datetime-local" />
            </label>
            <p class="muted">{{ packForm.assetIds.length }} asset(s) selected</p>
            <button
              type="submit"
              class="btn primary"
              :disabled="savingPack || !packForm.title.trim() || packForm.assetIds.length === 0"
            >
              {{
                savingPack
                  ? 'Saving…'
                  : isEditingPack
                    ? 'Save pack changes'
                    : 'Create pack'
              }}
            </button>
          </form>
        </section>

        <section class="panel">
          <h2>Packs</h2>
          <p v-if="!packs.length" class="muted">No packs yet.</p>
          <ul v-else class="pack-list">
            <li v-for="pack in packs" :key="pack.id" class="pack-card">
              <div class="pack-top">
                <div>
                  <h3>{{ pack.title }}</h3>
                  <p class="muted">
                    {{ pack.assetIds.length }} files · {{ pack.viewCount }} views ·
                    {{ pack.downloadCount }} downloads
                    <template v-if="pack.passwordRequired"> · password</template>
                    <template v-if="pack.expiresAt">
                      · expires {{ new Date(pack.expiresAt).toLocaleString() }}
                    </template>
                    <template v-if="pack.revokedAt"> · revoked</template>
                  </p>
                </div>
                <div class="actions">
                  <button type="button" class="link" @click="startEditPack(pack)">Edit</button>
                  <button
                    type="button"
                    class="link"
                    :disabled="!!pack.revokedAt"
                    @click="copyLink(pack.shareUrl)"
                  >
                    Copy link
                  </button>
                  <button
                    type="button"
                    class="link"
                    :disabled="!!pack.revokedAt"
                    @click="regenerateToken(pack.id)"
                  >
                    New link
                  </button>
                  <button
                    type="button"
                    class="link"
                    :disabled="!!pack.revokedAt"
                    @click="revokePack(pack.id)"
                  >
                    Revoke
                  </button>
                  <button type="button" class="link danger" @click="deletePack(pack.id)">Delete</button>
                </div>
              </div>
              <code class="share-url">{{ pack.shareUrl }}</code>
            </li>
          </ul>
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
