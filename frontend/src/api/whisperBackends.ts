import client from './client'

export interface WhisperBackend {
  id: number
  name: string
  backend_type: string
  url: string
  enabled: boolean
  priority: number
  created_at: string
}

export interface AvailableEngine {
  value: string
  label: string
  type: string
}

export interface HealthResult {
  ok: boolean
  latency_ms?: number
  error?: string
}

export const listWhisperBackends = () =>
  client.get<WhisperBackend[]>('/whisper/backends')

export const listAvailableEngines = () =>
  client.get<AvailableEngine[]>('/whisper/backends/available')

export const createWhisperBackend = (data: {
  name: string
  backend_type: string
  url: string
  priority?: number
}) => client.post<{ id: number; name: string }>('/whisper/backends', data)

export const updateWhisperBackend = (
  id: number,
  data: Partial<Omit<WhisperBackend, 'id' | 'created_at'>>
) => client.put(`/whisper/backends/${id}`, data)

export const deleteWhisperBackend = (id: number) =>
  client.delete(`/whisper/backends/${id}`)

export const healthCheckBackend = (id: number) =>
  client.post<HealthResult>(`/whisper/backends/${id}/health`)
