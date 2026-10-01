import type { QualityOption } from '@/api/stream'

// Keep the selected resolution, or use the source resolution for video copy.
export function compatibleQuality(quality: string, presets: QualityOption[]): string {
  const transcodes = presets.filter(p => p.value !== 'original' && p.value !== 'passthrough')
  return transcodes.find(p => p.value === quality)?.value
    ?? transcodes.reduce<QualityOption | undefined>((best, p) => !best || p.height > best.height ? p : best, undefined)?.value
    ?? '720p'
}

export function canTryCompatibility(quality: string, codec: string | undefined, alreadyTried: boolean): boolean {
  return !alreadyTried && (quality === 'original' || quality === 'passthrough' || codec !== 'h264')
}
