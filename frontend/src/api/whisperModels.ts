import client from './client'

export interface GPUInfo {
  device: string
  vram_total: number
  vram_free: number
  driver: string
}

export const getGPUInfo = () =>
  client.get<GPUInfo>('/gpu/info')
