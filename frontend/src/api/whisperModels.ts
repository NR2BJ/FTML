import client from './client'

export interface WhisperModel {
  name: string
  label: string
  size: string
  size_bytes: number
  description: string
  vram_required: number
  quantized: boolean
  downloaded: boolean
  active: boolean
  progress?: number
  fits_vram?: boolean | null
}

export interface GPUInfo {
  device: string
  vram_total: number
  vram_free: number
  driver: string
}

export interface DownloadProgress {
  progress: number
  done: boolean
  error?: string
}

export const listWhisperModels = () =>
  client.get<WhisperModel[]>('/whisper/models')

export const downloadWhisperModel = (model: string) =>
  client.post<{ status: string }>('/whisper/models/download', { model })

export const getDownloadProgress = (model: string) =>
  client.get<DownloadProgress>(`/whisper/models/progress?model=${encodeURIComponent(model)}`)

export const setActiveModel = (model: string) =>
  client.post<{ status: string; model: string; note: string }>('/whisper/models/active', { model })

export const deleteWhisperModel = (model: string) =>
  client.delete('/whisper/models', { data: { model } })

export const getGPUInfo = () =>
  client.get<GPUInfo>('/gpu/info')
