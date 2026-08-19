import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import {
  BRAND_CRF,
  BRAND_MAX_VIDEO_DURATION_SEC,
} from './brand-limits.js'
import type { BrandStoredMime } from './brand-media.js'

const ffmpegBin = process.env.FFMPEG_PATH?.trim() || 'ffmpeg'
const ffprobeBin = process.env.FFPROBE_PATH?.trim() || 'ffprobe'

export type ProbeResult = {
  durationSec: number | null
  width: number | null
  height: number | null
  videoCodec: string | null
  audioCodec: string | null
  hasVideo: boolean
  hasAudio: boolean
}

function runCommand(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${bin} timed out`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise({ stdout, stderr })
      else reject(new Error(`${bin} failed (${code}): ${stderr.slice(-800)}`))
    })
  })
}

export async function assertFfmpegAvailable(): Promise<void> {
  try {
    await runCommand(ffmpegBin, ['-version'], 10_000)
    await runCommand(ffprobeBin, ['-version'], 10_000)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `ffmpeg/ffprobe required for Brand Kit photo/video processing. Install system ffmpeg (H.264/AAC + HEIC/HEVC demux). ${message}`,
    )
  }
}

export async function probeBrandMedia(path: string): Promise<ProbeResult> {
  const { stdout } = await runCommand(
    ffprobeBin,
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      path,
    ],
    60_000,
  )
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string }
    streams?: Array<{
      codec_type?: string
      codec_name?: string
      width?: number
      height?: number
      duration?: string
    }>
  }
  const video = parsed.streams?.find((s) => s.codec_type === 'video')
  const audio = parsed.streams?.find((s) => s.codec_type === 'audio')
  const durationRaw = parsed.format?.duration ?? video?.duration
  const durationSec = durationRaw ? Number(durationRaw) : null
  return {
    durationSec: Number.isFinite(durationSec) ? durationSec : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
  }
}

export type TranscodeResult = {
  outputPath: string
  posterPath: string | null
  mimeType: BrandStoredMime
  width: number | null
  height: number | null
  durationSeconds: number | null
  passThrough: boolean
}

/**
 * Convert iPhone HEIC/MOV/HEVC (and other inputs) to web-ready JPEG/MP4.
 * Preserves source pixel dimensions. CRF 18 is visually lossless for H.264 —
 * not mathematically lossless, and may not shrink already-efficient HEVC.
 */
export async function transcodeBrandUpload(params: {
  sourcePath: string
  sessionDir: string
  sourceMime: string
}): Promise<TranscodeResult> {
  const { sourcePath, sessionDir, sourceMime } = params
  const mime = sourceMime.toLowerCase()

  if (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp') {
    let width: number | null = null
    let height: number | null = null
    try {
      const probe = await probeBrandMedia(sourcePath)
      width = probe.width
      height = probe.height
    } catch {
      /* optional for passthrough images */
    }
    return {
      outputPath: sourcePath,
      posterPath: null,
      mimeType: mime as BrandStoredMime,
      width,
      height,
      durationSeconds: null,
      passThrough: true,
    }
  }

  await assertFfmpegAvailable()
  const probe = await probeBrandMedia(sourcePath)

  if (mime.startsWith('image/')) {
    // HEIC / HEIF → high-quality JPEG, auto-orient, preserve dimensions
    const outputPath = resolve(sessionDir, 'output.jpg')
    await runCommand(
      ffmpegBin,
      [
        '-y',
        '-i',
        sourcePath,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        '-vf',
        'scale=iw:ih',
        outputPath,
      ],
      180_000,
    )
    const outProbe = await probeBrandMedia(outputPath).catch(() => probe)
    return {
      outputPath,
      posterPath: null,
      mimeType: 'image/jpeg',
      width: outProbe.width ?? probe.width,
      height: outProbe.height ?? probe.height,
      durationSeconds: null,
      passThrough: false,
    }
  }

  // Video path
  if (probe.durationSec != null && probe.durationSec > BRAND_MAX_VIDEO_DURATION_SEC) {
    throw new Error(`Video longer than ${BRAND_MAX_VIDEO_DURATION_SEC / 60} minutes`)
  }
  if (!probe.hasVideo) throw new Error('Upload does not contain a video track')

  const outputPath = resolve(sessionDir, 'output.mp4')
  const posterPath = resolve(sessionDir, 'poster.jpg')

  // Compatible H.264 already? Still remux/transcode lightly for +faststart + AAC.
  // Preserve dimensions: no downscale filter beyond scale=iw:ih identity.
  await runCommand(
    ffmpegBin,
    [
      '-y',
      '-i',
      sourcePath,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      'libx264',
      '-crf',
      String(BRAND_CRF),
      '-preset',
      'slow',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      'scale=iw:ih',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      outputPath,
    ],
    900_000,
  )

  const seek =
    probe.durationSec && probe.durationSec > 2 ? ['-ss', '1'] : ['-ss', '0']
  await runCommand(
    ffmpegBin,
    ['-y', ...seek, '-i', outputPath, '-frames:v', '1', '-q:v', '2', posterPath],
    60_000,
  )

  const outProbe = await probeBrandMedia(outputPath)
  return {
    outputPath,
    posterPath,
    mimeType: 'video/mp4',
    width: outProbe.width ?? probe.width,
    height: outProbe.height ?? probe.height,
    durationSeconds:
      outProbe.durationSec != null
        ? Math.round(outProbe.durationSec)
        : probe.durationSec != null
          ? Math.round(probe.durationSec)
          : null,
    passThrough: false,
  }
}

/** Exposed for tests — encoding flags that preserve resolution. */
export function videoTranscodeArgs(sourcePath: string, outputPath: string): string[] {
  return [
    '-y',
    '-i',
    sourcePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'libx264',
    '-crf',
    String(BRAND_CRF),
    '-preset',
    'slow',
    '-pix_fmt',
    'yuv420p',
    '-vf',
    'scale=iw:ih',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    outputPath,
  ]
}
