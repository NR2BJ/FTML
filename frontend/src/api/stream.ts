import client from './client'
import type { BrowserCodecSupport } from '@/utils/codec'

const getToken = () => localStorage.getItem('token') || ''

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
      av1: browserCodecs.av1,
      vp9: browserCodecs.vp9,
    },
  })

export const getPresets = (path: string, codec?: string, browserCodecs?: BrowserCodecSupport) => {
  const params: Record<string, string> = {}
  if (codec) params.codec = codec
  if (browserCodecs) {
    params.h264 = String(browserCodecs.h264)
    params.hevc = String(browserCodecs.hevc)
    params.av1 = String(browserCodecs.av1)
    params.vp9 = String(browserCodecs.vp9)
  }
  return client.get<QualityOption[]>(`/stream/presets/${path}`, { params })
}

export const getHLSUrl = (path: string, quality: string = '720p', startTime: number = 0, codec?: string) => {
  let url = `/api/stream/hls/${path}?token=${getToken()}&quality=${quality}`
  if (startTime > 0) {
    url += `&start=${Math.floor(startTime)}`
  }
  if (codec) {
    url += `&codec=${codec}`
  }
  return url
}

export const getDirectUrl = (path: string) =>
  `/api/stream/direct/${path}?token=${getToken()}`

export const sendHeartbeat = (sessionID: string) =>
  client.post(`/stream/heartbeat/${sessionID}`)

export const pauseSession = (sessionID: string) =>
  client.post(`/stream/pause/${sessionID}`)

export const resumeSession = (sessionID: string) =>
  client.post(`/stream/resume/${sessionID}`)

export const stopSession = (sessionID: string) =>
  client.delete(`/stream/session/${sessionID}`)
