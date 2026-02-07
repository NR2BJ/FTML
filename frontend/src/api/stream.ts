import client from './client'

const getToken = () => localStorage.getItem('token') || ''

export interface QualityOption {
  value: string
  label: string
  desc: string
  height: number
  crf: number
  max_bitrate: string
  buf_size: string
}

export const getPresets = (path: string) =>
  client.get<QualityOption[]>(`/stream/presets/${path}`)

export const getHLSUrl = (path: string, quality: string = '720p', startTime: number = 0) => {
  let url = `/api/stream/hls/${path}?token=${getToken()}&quality=${quality}`
  if (startTime > 0) {
    url += `&start=${Math.floor(startTime)}`
  }
  return url
}

export const getDirectUrl = (path: string) =>
  `/api/stream/direct/${path}?token=${getToken()}`
