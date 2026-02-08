import client from './client'

export interface OVWhisperModel {
  model_id: string
  label: string
  size: string          // "tiny", "base", "small", "medium", "large-v3", "distil-large-v2", "distil-large-v3"
  quant: string         // "int8", "int4", "fp16"
  english_only: boolean // true for .en models
  downloads: number
  active: boolean
}

export interface GPUInfo {
  device: string
  vram_total: number
  vram_free: number
  driver: string
}

export const listWhisperModels = () =>
  client.get<OVWhisperModel[]>('/whisper/models')

export const setActiveModel = (modelId: string) =>
  client.post<{ status: string; model_id: string }>('/whisper/models/active', { model_id: modelId })

export const getGPUInfo = () =>
  client.get<GPUInfo>('/gpu/info')
