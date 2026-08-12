<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'
import { resolveMediaUrl } from '@/lib/api'
import AccessibleDialog from '@/components/AccessibleDialog.vue'

type MomentStatus = 'pending' | 'approved' | 'rejected'

type Moment = {
  id: string
  status: MomentStatus
  submitterName?: string | null
  submitterEmail?: string | null
  mediaKind: 'image' | 'video'
  mimeType: string
  originalFilename?: string | null
  byteSize: number
  durationSeconds?: number | null
  reviewNote?: string | null
  groupLabel?: string | null
  reviewedById?: string | null
  reviewedAt?: string | null
  createdAt: string
  mediaUrl: string
  posterUrl?: string | null
}

type MomentsResponse = {
  moments: Moment[]
  summary: {
    total: number
    pending: number
    approved: number
    rejected: number
  }
}

const { t, locale } = useI18n()
const moments = ref<Moment[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const statusFilter = ref<MomentStatus>('pending')
const summary = ref({ total: 0, pending: 0, approved: 0, rejected: 0 })
const activeAction = ref<string | null>(null)
const reviewingMoment = ref<Moment | null>(null)
const reviewNote = ref('')
const groupLabel = ref('')
const page = ref(1)
const PAGE_SIZE = 24
const pageCount = computed(() => Math.max(1, Math.ceil(moments.value.length / PAGE_SIZE)))
const visibleMoments = computed(() =>
  moments.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
)
let loadRequestId = 0

function statusLabel(status: MomentStatus): string {
  return t(`moments.status.${status}`)
}

function formatDate(value: string | null | undefined): string {
  if (!value) return t('moments.notAvailable')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return t('moments.notAvailable')
  return new Intl.DateTimeFormat(locale?.value ?? 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function formatSize(bytes: number): string {
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

function submitterLabel(moment: Moment): string {
  if (moment.submitterName) return moment.submitterName
  if (moment.submitterEmail) return moment.submitterEmail
  return t('moments.anonymous')
}

async function loadMoments() {
  const requestId = ++loadRequestId
  const requestedStatus = statusFilter.value
  loading.value = true
  error.value = null
  try {
    const data = await api<MomentsResponse>(`/api/moments?status=${requestedStatus}`)
    if (requestId !== loadRequestId) return
    moments.value = data.moments ?? []
    page.value = 1
    summary.value = data.summary ?? {
      total: moments.value.length,
      pending: requestedStatus === 'pending' ? moments.value.length : 0,
      approved: requestedStatus === 'approved' ? moments.value.length : 0,
      rejected: requestedStatus === 'rejected' ? moments.value.length : 0,
    }
  } catch (e) {
    if (requestId !== loadRequestId) return
    error.value = e instanceof Error ? e.message : t('moments.loadFailed')
  } finally {
    if (requestId === loadRequestId) loading.value = false
  }
}

function selectStatus(status: MomentStatus) {
  if (status === statusFilter.value && !error.value) return
  statusFilter.value = status
  notice.value = null
  void loadMoments()
}

async function refresh() {
  notice.value = null
  await loadMoments()
}

function openReview(moment: Moment) {
  reviewingMoment.value = moment
  reviewNote.value = ''
  groupLabel.value = moment.groupLabel ?? ''
}

function closeReview() {
  reviewingMoment.value = null
  reviewNote.value = ''
  groupLabel.value = ''
}

async function submitReview(status: 'approved' | 'rejected') {
  if (!reviewingMoment.value) return
  const moment = reviewingMoment.value
  
  if (activeAction.value) return
  activeAction.value = `${moment.id}:review`
  error.value = null
  notice.value = null
  
  try {
    await api(`/api/moments/${moment.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status,
        reviewNote: reviewNote.value.trim() || undefined,
        groupLabel: groupLabel.value.trim() || null,
      }),
    })
    await loadMoments()
    notice.value = status === 'approved' ? t('moments.approved') : t('moments.rejected')
    closeReview()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('moments.actionFailed')
  } finally {
    activeAction.value = null
  }
}

function actionBusy(moment: Moment, action: string): boolean {
  return activeAction.value === `${moment.id}:${action}`
}

onMounted(() => {
  loadMoments()
})
</script>

<template>
  <AppLayout>
    <div class="moments-view">
      <header class="view-header">
        <div class="header-content">
          <div class="header-text">
            <div class="eyebrow">{{ t('moments.eyebrow') }}</div>
            <h1 class="view-title">{{ t('moments.title') }}</h1>
            <p class="view-subtitle">{{ t('moments.subtitle') }}</p>
          </div>
          <div class="header-actions">
            <button type="button" class="button secondary" @click="refresh" :disabled="loading">
              {{ t('moments.refresh') }}
            </button>
          </div>
        </div>
      </header>

      <div v-if="notice" class="notice success" role="status" aria-live="polite">{{ notice }}</div>
      <div v-if="error && !loading" class="notice error" role="alert">
        {{ error }}
        <button type="button" class="link-button" @click="refresh">{{ t('moments.tryAgain') }}</button>
      </div>

      <div class="summary-cards">
        <button
          type="button"
          class="summary-card"
          :class="{ active: statusFilter === 'pending' }"
          :aria-pressed="statusFilter === 'pending'"
          @click="selectStatus('pending')"
        >
          <div class="summary-count">{{ summary.pending }}</div>
          <div class="summary-label">{{ t('moments.status.pending') }}</div>
        </button>
        <button
          type="button"
          class="summary-card"
          :class="{ active: statusFilter === 'approved' }"
          :aria-pressed="statusFilter === 'approved'"
          @click="selectStatus('approved')"
        >
          <div class="summary-count">{{ summary.approved }}</div>
          <div class="summary-label">{{ t('moments.status.approved') }}</div>
        </button>
        <button
          type="button"
          class="summary-card"
          :class="{ active: statusFilter === 'rejected' }"
          :aria-pressed="statusFilter === 'rejected'"
          @click="selectStatus('rejected')"
        >
          <div class="summary-count">{{ summary.rejected }}</div>
          <div class="summary-label">{{ t('moments.status.rejected') }}</div>
        </button>
      </div>

      <div v-if="loading" class="loading" role="status" aria-live="polite">{{ t('moments.loading') }}</div>

      <div v-else-if="summary.total === 0" class="empty">
        {{ t('moments.empty') }}
      </div>

      <div v-else-if="moments.length === 0" class="empty">
        {{ t('moments.noMatches') }}
      </div>

      <div v-else class="moments-grid">
        <div v-for="moment in visibleMoments" :key="moment.id" class="moment-card">
          <div class="moment-preview">
            <img
              v-if="moment.mediaKind === 'image'"
              :src="resolveMediaUrl(moment.mediaUrl)"
              :alt="moment.originalFilename || t('moments.imageAlt')"
              class="moment-media"
              loading="lazy"
            />
            <video
              v-else
              :src="resolveMediaUrl(moment.mediaUrl)"
              controls
              preload="none"
              :aria-label="moment.originalFilename || t('moments.videoLabel')"
              class="moment-media"
            />
          </div>
          <div class="moment-info">
            <div class="moment-meta">
              <span class="badge" :class="moment.status">{{ statusLabel(moment.status) }}</span>
              <span class="moment-kind">{{ t(`moments.mediaKind.${moment.mediaKind}`) }}</span>
            </div>
            <div class="moment-details">
              <p class="submitter">{{ submitterLabel(moment) }}</p>
              <p class="timestamp">{{ formatDate(moment.createdAt) }}</p>
              <p class="file-info">{{ formatSize(moment.byteSize) }}</p>
              <p v-if="moment.reviewedAt" class="reviewed">
                {{ t('moments.reviewedAt', { date: formatDate(moment.reviewedAt) }) }}
              </p>
              <p v-if="moment.reviewNote" class="review-note">{{ moment.reviewNote }}</p>
              <p v-if="moment.groupLabel" class="group-label">{{ moment.groupLabel }}</p>
            </div>
            <div v-if="moment.status === 'pending'" class="moment-actions">
              <button
                type="button"
                class="button secondary small"
                @click="openReview(moment)"
                :disabled="actionBusy(moment, 'review')"
              >
                {{ t('moments.review') }}
              </button>
            </div>
          </div>
        </div>
      </div>
      <nav v-if="pageCount > 1" class="pagination" :aria-label="t('moments.pagination')">
        <button type="button" class="button secondary small" :disabled="page === 1" @click="page--">{{ t('moments.previous') }}</button>
        <span>{{ t('moments.page', { current: page, total: pageCount }) }}</span>
        <button type="button" class="button secondary small" :disabled="page === pageCount" @click="page++">{{ t('moments.next') }}</button>
      </nav>

      <!-- Review Modal -->
      <AccessibleDialog
        :open="!!reviewingMoment"
        title-id="review-moment-title"
        :close-label="t('dialog.close')"
        @close="closeReview"
      >
        <div v-if="reviewingMoment" class="modal">
          <div class="modal-header">
            <h2 id="review-moment-title">{{ t('moments.reviewMoment') }}</h2>
            <button type="button" class="close-button" :aria-label="t('dialog.close')" @click="closeReview">&times;</button>
          </div>
          <div class="modal-body">
            <div class="review-preview">
              <img
                v-if="reviewingMoment.mediaKind === 'image'"
                :src="resolveMediaUrl(reviewingMoment.mediaUrl)"
                :alt="reviewingMoment.originalFilename || t('moments.imageAlt')"
                class="review-media"
              />
              <video
                v-else
                :src="resolveMediaUrl(reviewingMoment.mediaUrl)"
                controls
                preload="metadata"
                :aria-label="reviewingMoment.originalFilename || t('moments.videoLabel')"
                class="review-media"
              />
            </div>
            <div class="form-group">
              <label for="groupLabel">{{ t('moments.groupLabel') }}</label>
              <input
                id="groupLabel"
                v-model="groupLabel"
                :placeholder="t('moments.groupLabelPlaceholder')"
                maxlength="80"
                class="form-control"
              />
              <p class="form-hint">{{ t('moments.groupLabelHint') }}</p>
            </div>
            <div class="form-group">
              <label for="reviewNote">{{ t('moments.reviewNote') }}</label>
              <textarea
                id="reviewNote"
                v-model="reviewNote"
                :placeholder="t('moments.reviewNotePlaceholder')"
                rows="3"
                maxlength="500"
                class="form-control"
              />
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="button secondary" @click="closeReview">
              {{ t('moments.cancel') }}
            </button>
            <button
              type="button"
              class="button danger"
              @click="submitReview('rejected')"
              :disabled="!!activeAction"
            >
              {{ t('moments.reject') }}
            </button>
            <button
              type="button"
              class="button primary"
              @click="submitReview('approved')"
              :disabled="!!activeAction"
            >
              {{ t('moments.approve') }}
            </button>
          </div>
        </div>
      </AccessibleDialog>
    </div>
  </AppLayout>
</template>

<style scoped>
.moments-view {
  max-width: 1400px;
  margin: 0 auto;
  padding: clamp(0rem, 2vw, 2rem);
}

.view-header {
  margin-bottom: 2rem;
}

.header-content {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1.5rem;
}

.eyebrow {
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #718075;
  margin-bottom: 0.5rem;
}

.view-title {
  font-size: 2rem;
  font-weight: 800;
  color: var(--os-fg);
  margin: 0 0 0.5rem 0;
}

.view-subtitle {
  font-size: 1rem;
  color: var(--os-muted);
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 0.75rem;
}

.notice {
  padding: 1rem 1.5rem;
  border-radius: 8px;
  margin-bottom: 1.5rem;
  display: flex;
  align-items: center;
  gap: 1rem;
}

.notice.success {
  background: #e8f4e6;
  color: #276338;
}

.notice.error {
  background: #fef2f2;
  color: #991b1b;
}

.link-button {
  background: none;
  border: none;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
  font-weight: 600;
}

.summary-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
}

.summary-card {
  background: var(--os-shell-muted);
  border: 2px solid var(--os-border);
  border-radius: 12px;
  padding: 1.5rem;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
}

.summary-card:hover {
  border-color: #2f6b3b;
}

.summary-card.active {
  border-color: #2f6b3b;
  background: color-mix(in srgb, var(--os-shell-muted) 80%, #2f6b3b);
}

.summary-count {
  font-size: 2.5rem;
  font-weight: 800;
  color: var(--os-fg);
}

.summary-label {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--os-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.loading,
.empty {
  text-align: center;
  padding: 3rem;
  color: #718075;
  font-size: 1.125rem;
}

.moments-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
  gap: 1.5rem;
}

.moment-card {
  background: var(--os-shell-muted);
  border: 1px solid var(--os-border);
  border-radius: 12px;
  overflow: hidden;
  transition: box-shadow 0.2s;
}

.moment-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}

.moment-preview {
  aspect-ratio: 4 / 3;
  background: #f4f7f2;
  overflow: hidden;
}

.moment-media {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.moment-info {
  padding: 1rem;
}

.moment-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.badge {
  padding: 0.25rem 0.75rem;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
}

.badge.pending {
  background: #fef3c7;
  color: #92400e;
}

.badge.approved {
  background: #d1fae5;
  color: #065f46;
}

.badge.rejected {
  background: #fee2e2;
  color: #991b1b;
}

.moment-kind {
  font-size: 0.875rem;
  color: #718075;
  text-transform: capitalize;
}

.moment-details p {
  margin: 0.25rem 0;
  font-size: 0.875rem;
}

.submitter {
  font-weight: 600;
  color: var(--os-fg);
}

.timestamp,
.file-info {
  color: #718075;
}

.reviewed {
  color: #617064;
  font-size: 0.8125rem;
  margin-top: 0.5rem;
}

.review-note {
  color: #617064;
  font-style: italic;
  margin-top: 0.5rem;
}

.group-label {
  color: #2f6b3b;
  font-weight: 700;
}

.moment-actions {
  margin-top: 1rem;
}

.button {
  padding: 0.625rem 1.25rem;
  border: none;
  border-radius: 8px;
  font-weight: 700;
  font-size: 0.875rem;
  cursor: pointer;
  transition: all 0.2s;
}

.button.primary {
  background: #2f6b3b;
  color: white;
}

.button.primary:hover:not(:disabled) {
  background: #276338;
}

.button.secondary {
  background: var(--os-shell-muted);
  border: 2px solid var(--os-border);
  color: var(--os-fg);
}

.button.secondary:hover:not(:disabled) {
  border-color: #2f6b3b;
  color: #2f6b3b;
}

.button.danger {
  background: #dc2626;
  color: white;
}

.button.danger:hover:not(:disabled) {
  background: #991b1b;
}

.button.small {
  padding: 0.5rem 1rem;
  font-size: 0.8125rem;
}

.button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
}

.modal {
  background: var(--os-shell);
  border-radius: 16px;
  max-width: 800px;
  width: 100%;
  max-height: 90vh;
  overflow: auto;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.5rem;
  border-bottom: 1px solid #e2e9df;
}

.modal-header h2 {
  margin: 0;
  font-size: 1.5rem;
  color: var(--os-fg);
}

.close-button {
  background: none;
  border: none;
  font-size: 2rem;
  color: #718075;
  cursor: pointer;
  line-height: 1;
  padding: 0;
  width: 2rem;
  height: 2rem;
}

.modal-body {
  padding: 1.5rem;
}

.review-preview {
  margin-bottom: 1.5rem;
  background: #f4f7f2;
  border-radius: 12px;
  overflow: hidden;
}

.review-media {
  width: 100%;
  display: block;
}

.form-group {
  margin-bottom: 1rem;
}

.form-group label {
  display: block;
  font-weight: 600;
  color: var(--os-fg);
  margin-bottom: 0.5rem;
}

.form-control {
  width: 100%;
  padding: 0.75rem;
  border: 2px solid var(--os-border);
  background: var(--os-shell-muted);
  color: var(--os-fg);
  border-radius: 8px;
  font-family: inherit;
  font-size: 0.875rem;
  resize: vertical;
}

.form-control:focus {
  outline: none;
  border-color: #2f6b3b;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  padding: 1.5rem;
  border-top: 1px solid #e2e9df;
}

.pagination {
  margin-top: 1.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  color: var(--os-muted);
  font-size: 0.875rem;
}
</style>
