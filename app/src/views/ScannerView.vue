<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

type ScanResult = { kind: 'inventory' | 'asset'; record: Record<string, unknown> }
type Detector = { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> }
type DetectorConstructor = new (options?: { formats?: string[] }) => Detector
const code = ref('')
const { t } = useI18n()
const result = ref<ScanResult | null>(null)
const error = ref('')
const loading = ref(false)
const cameraOn = ref(false)
const video = ref<HTMLVideoElement | null>(null)
const label = ref<{ name: string; detail: string; payload: string; qr: string } | null>(null)
let stream: MediaStream | null = null
let frame = 0

async function resolveCode(value = code.value) { const cleaned = value.trim(); if (!cleaned) return; loading.value = true; error.value = ''; result.value = null; try { result.value = await api(`/api/scanning/resolve?code=${encodeURIComponent(cleaned)}`); code.value = cleaned; stopCamera() } catch (e) { error.value = e instanceof Error ? e.message : t('roadmapFeatures.scan.notFound') } finally { loading.value = false } }
async function startCamera() {
  error.value = ''
  const BarcodeDetector = (window as unknown as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector
  if (!BarcodeDetector) { error.value = t('roadmapFeatures.scan.notSupported'); return }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
    cameraOn.value = true
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!video.value) return
    video.value.srcObject = stream
    await video.value.play()
    const detector = new BarcodeDetector({ formats: ['qr_code', 'code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e'] })
    const tick = async () => { if (!cameraOn.value || !video.value) return; try { const values = await detector.detect(video.value); if (values[0]?.rawValue) { code.value = values[0].rawValue; await resolveCode(values[0].rawValue); return } } catch { /* keep scanning */ } frame = requestAnimationFrame(tick) }
    frame = requestAnimationFrame(tick)
  } catch { error.value = t('roadmapFeatures.scan.noPermission'); stopCamera() }
}
function stopCamera() { cameraOn.value = false; cancelAnimationFrame(frame); stream?.getTracks().forEach((track) => track.stop()); stream = null; if (video.value) video.value.srcObject = null }
async function loadLabel() { if (!result.value) return; const id = String(result.value.record.id); try { label.value = await api(`/api/scanning/label/${result.value.kind}/${id}`) } catch (e) { error.value = e instanceof Error ? e.message : t('roadmapFeatures.scan.labelFailed') } }
function printLabel() { window.print() }
onBeforeUnmount(stopCamera)
</script>
<template>
  <AppLayout>
    <div><p class="text-xs font-bold uppercase tracking-[.2em] text-farm-green">{{ t('roadmapFeatures.scan.eyebrow') }}</p><h2 class="mt-1 text-2xl font-black text-os-fg">{{ t('roadmapFeatures.scan.title') }}</h2><p class="mt-1 text-sm text-slate-400">{{ t('roadmapFeatures.scan.subtitle') }}</p></div>
    <div class="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,.9fr)]">
      <section class="rounded-2xl border border-slate-800 bg-slate-900 p-5"><button v-if="!cameraOn" class="w-full rounded-2xl bg-farm-green py-4 text-base font-black text-slate-950" @click="startCamera">{{ t('roadmapFeatures.scan.openCamera') }}</button><div v-else class="overflow-hidden rounded-2xl border-2 border-farm-green"><video ref="video" playsinline muted class="aspect-[4/3] w-full bg-black object-cover"/><button class="w-full bg-slate-950 py-3 text-sm font-bold text-white" @click="stopCamera">{{ t('roadmapFeatures.scan.stopCamera') }}</button></div><div class="my-5 flex items-center gap-3 text-xs uppercase tracking-widest text-slate-500"><span class="h-px flex-1 bg-slate-800"/>{{ t('roadmapFeatures.scan.orType') }}<span class="h-px flex-1 bg-slate-800"/></div><form class="flex flex-col gap-2 sm:flex-row" @submit.prevent="resolveCode()"><input v-model="code" autocomplete="off" class="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white" :placeholder="t('roadmapFeatures.scan.placeholder')"/><button :disabled="loading || !code.trim()" class="rounded-xl bg-slate-700 px-5 py-3 font-bold text-white disabled:opacity-40">{{ loading ? t('roadmapFeatures.scan.finding') : t('roadmapFeatures.scan.find') }}</button></form><p class="mt-3 text-xs text-slate-500">{{ t('roadmapFeatures.scan.browserHint') }}</p></section>
      <section class="rounded-2xl border border-slate-800 bg-slate-900 p-5"><h3 class="font-bold text-white">{{ t('roadmapFeatures.scan.resultTitle') }}</h3><p v-if="error" class="mt-4 rounded-xl bg-red-950/30 p-3 text-sm text-red-300">{{ error }}</p><p v-else-if="!result" class="mt-4 text-sm text-slate-500">{{ t('roadmapFeatures.scan.empty') }}</p><div v-else class="mt-4"><span class="rounded-full bg-farm-green/15 px-2 py-1 text-[10px] font-black uppercase text-farm-green">{{ result.kind }}</span><h4 class="mt-3 text-xl font-black text-white">{{ result.record.name }}</h4><p class="mt-1 text-sm text-slate-400">{{ result.kind === 'inventory' ? `${result.record.sku} · ${result.record.quantity} ${result.record.unit}` : (result.record.assetTag || result.record.serialNumber || t('roadmapFeatures.scan.equipment')) }}</p><div class="mt-5 flex flex-wrap gap-2"><RouterLink :to="result.kind === 'inventory' ? '/inventory' : '/assets'" class="rounded-xl bg-farm-green px-4 py-2 text-sm font-bold text-slate-950">{{ t('roadmapFeatures.scan.openRecord') }}</RouterLink><RouterLink v-if="result.kind === 'asset'" to="/maintenance" class="rounded-xl bg-slate-700 px-4 py-2 text-sm font-bold text-white">{{ t('roadmapFeatures.scan.maintenance') }}</RouterLink><button class="rounded-xl border border-slate-700 px-4 py-2 text-sm font-bold text-slate-200" @click="loadLabel">{{ t('roadmapFeatures.scan.showLabel') }}</button></div></div></section>
    </div>
    <div v-if="label" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" @click.self="label = null"><div class="label-card w-full max-w-sm rounded-2xl bg-white p-6 text-center text-slate-950"><h3 class="text-xl font-black">{{ label.name }}</h3><p class="mt-1 text-sm">{{ label.detail }}</p><img :src="label.qr" :alt="`QR label for ${label.name}`" class="mx-auto mt-4 w-64 max-w-full"/><p class="mt-2 break-all font-mono text-[10px]">{{ label.payload }}</p><div class="no-print mt-5 flex justify-center gap-2"><button class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white" @click="printLabel">{{ t('roadmapFeatures.scan.print') }}</button><button class="rounded-lg bg-slate-200 px-4 py-2 text-sm font-bold" @click="label = null">{{ t('roadmapFeatures.scan.close') }}</button></div></div></div>
  </AppLayout>
</template>
<style scoped>@media print{.label-card{position:fixed;inset:0;margin:auto;border:0}.no-print{display:none}}</style>
