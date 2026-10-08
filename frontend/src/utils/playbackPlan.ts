import type { QualityOption, CapabilitiesResponse } from '@/api/stream'
import type { BrowserCodecSupport } from './codec'

export interface PlaybackAttempt {
  quality: string
  codec: string
  acceleration: 'direct' | 'copy' | 'hardware' | 'hybrid' | 'software'
}
export type FailureReason = 'browser' | 'server' | 'slow'
export const attemptKey = (a: PlaybackAttempt) => `${a.quality}:${a.codec}:${a.acceleration}`

export function buildPlaybackPlan(quality: string, presets: QualityOption[], encoders: CapabilitiesResponse['server_encoders'], browser: BrowserCodecSupport, sourceCodec: string, audioTrack: number): PlaybackAttempt[] {
  const plan: PlaybackAttempt[] = []
  const original = presets.find(p => p.value === 'original')
  const transcodes = presets.filter(p => p.height > 0 && p.value !== 'original' && p.value !== 'passthrough')
  const target = transcodes.find(p => p.value === quality) ?? transcodes.reduce<QualityOption | undefined>((best, p) => !best || p.height > best.height ? p : best, undefined)
  if (['auto', 'original', 'passthrough'].includes(quality)) {
    if (quality !== 'passthrough' && original?.can_original && audioTrack === 0) plan.push({ quality: 'original', codec: sourceCodec, acceleration: 'direct' })
    if (original?.can_original_video || presets.some(p => p.value === 'passthrough')) plan.push({ quality: 'passthrough', codec: sourceCodec, acceleration: 'copy' })
  }
  if (!target) return plan
  // 높은 압축 효율보다 실제 재생/변환 가능 여부가 먼저다. CPU AV1 자동 선택은 피한다.
  for (const codec of ['av1', 'hevc', 'h264'] as const) {
    if (!browser[codec]) continue
    if (encoders.some(e => e.codec === codec && e.hwaccel === 'vaapi')) {
      plan.push({ quality: target.value, codec, acceleration: 'hardware' }, { quality: target.value, codec, acceleration: 'hybrid' })
    }
  }
  if (browser.h264 && encoders.some(e => e.codec === 'h264' && !e.hwaccel)) {
    plan.push({ quality: target.value, codec: 'h264', acceleration: 'software' })
  }
  return plan
}

export function rejectAttempt(plan: PlaybackAttempt[], current: PlaybackAttempt, reason: FailureReason, rejected: Set<string>): void {
  rejected.add(attemptKey(current))
  if ((reason === 'browser' || reason === 'slow') && !['direct', 'copy'].includes(current.acceleration)) {
    for (const a of plan) {
      if (a.codec === current.codec && (reason === 'browser' || a.acceleration === 'hybrid')) rejected.add(attemptKey(a))
    }
  }
}
