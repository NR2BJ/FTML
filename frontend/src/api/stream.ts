import client from './client'
import { encodeMediaPath } from '@/utils/mediaPath'
import type { BrowserCodecSupport } from '@/utils/codec'

export interface QualityOption {
  value: string
  label: string
  desc: string
  height: number
  crf: number
  max_bitrate: string
  buf_size: string
  video_codec: string
  audio_codec: string
  can_original?: boolean
  can_original_video?: boolean
  can_original_audio?: boolean
}

export interface CapabilitiesResponse {
  server_encoders: Array<{
    codec: string
    encoder: string
    hwaccel: string
    device: string
  }>
  hwaccel: string
  device: string
  selected_codec: string
  selected_encoder: string
  browser_support: {
    h264: boolean
    hevc: boolean
    av1: boolean
    vp9: boolean
  }
}

export const getCapabilities = (browserCodecs: BrowserCodecSupport) =>
  client.get<CapabilitiesResponse>('/stream/capabilities', {
    params: {
      h264: browserCodecs.h264,
      hevc: browserCodecs.hevc,
      hevc10: browserCodecs.hevc10,
      av1: browserCodecs.av1,
      vp9: browserCodecs.vp9,
      aac: browserCodecs.aac,
      opus: browserCodecs.opus,
      flac: browserCodecs.flac,
      ac3: browserCodecs.ac3,
    },
  })

export const getPresets = (path: string, codec?: string, browserCodecs?: BrowserCodecSupport) => {
  const params: Record<string, string> = {}
  if (codec) params.codec = codec
  if (browserCodecs) {
    params.h264 = String(browserCodecs.h264)
    params.hevc = String(browserCodecs.hevc)
    params.hevc10 = String(browserCodecs.hevc10)
    params.av1 = String(browserCodecs.av1)
    params.vp9 = String(browserCodecs.vp9)
    params.aac = String(browserCodecs.aac)
    params.opus = String(browserCodecs.opus)
    params.flac = String(browserCodecs.flac)
    params.ac3 = String(browserCodecs.ac3)
  }
  return client.get<QualityOption[]>(`/stream/presets/${encodeMediaPath(path)}`, { params })
}

export const getHLSUrl = (path: string, sessionID: string, quality = '720p', startTime = 0, codec?: string, audioTrack = 0) => {
  const params = new URLSearchParams({ session: sessionID, quality, start: String(startTime), audio: String(audioTrack) })
  if (codec) params.set('codec', codec)
  return `/api/stream/hls/${encodeMediaPath(path)}/playlist.m3u8?${params}`
}

export const getDirectUrl = (path: string) =>
  `/api/stream/direct/${encodeMediaPath(path)}`

export const sendHeartbeat = (sessionID: string) =>
  client.post(`/stream/heartbeat/${sessionID}`)

export const pauseSession = (sessionID: string) =>
  client.post(`/stream/pause/${sessionID}`)

export const resumeSession = (sessionID: string) =>
  client.post(`/stream/resume/${sessionID}`)

export const stopSession = (sessionID: string) =>
  client.delete(`/stream/session/${sessionID}`)
