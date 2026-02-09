import client from './client'

export interface SubtitleEntry {
  id: string
  label: string
  language: string
  type: 'embedded' | 'external' | 'generated'
  format: string
}

export interface Job {
  id: string
  type: 'transcribe' | 'translate'
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  file_path: string
  params: Record<string, unknown>
  progress: number
  result?: Record<string, unknown>
  error?: string
  created_at: string
  started_at?: string
  completed_at?: string
}

export interface GenerateParams {
  engine: string   // "whisper.cpp" | "openai"
  model: string    // "large-v3" | "medium" | "small" etc.
  language: string // "auto" | "ko" | "en" | "ja" etc.
}

export interface TranslateParams {
  subtitle_id: string
  target_lang: string
  engine: string   // "gemini" | "openai" | "deepl"
  preset: string   // "anime" | "movie" | "documentary" | "custom"
  custom_prompt?: string
}

export const listSubtitles = (path: string) =>
  client.get<SubtitleEntry[]>(`/subtitle/list/${path}`)

const getToken = () => localStorage.getItem('token') || ''

export const getSubtitleUrl = (videoPath: string, subtitleId: string) =>
  `/api/subtitle/content/${videoPath}?id=${encodeURIComponent(subtitleId)}&token=${getToken()}`

export const generateSubtitle = (path: string, params: GenerateParams) =>
  client.post<{ job_id: string }>(`/subtitle/generate/${path}`, params)

export const translateSubtitle = (path: string, params: TranslateParams) =>
  client.post<{ job_id: string }>(`/subtitle/translate/${path}`, params)

export const deleteSubtitle = (path: string, subtitleId: string) =>
  client.delete(`/subtitle/delete/${path}?id=${encodeURIComponent(subtitleId)}`)

export const getJob = (jobId: string) =>
  client.get<Job>(`/jobs/${jobId}`)

export const listJobs = () =>
  client.get<Job[]>(`/jobs`)

export const cancelJob = (jobId: string) =>
  client.delete(`/jobs/${jobId}`)

export const retryJob = (jobId: string) =>
  client.post(`/jobs/${jobId}/retry`)

export const uploadSubtitle = (videoPath: string, file: File) => {
  const formData = new FormData()
  formData.append('file', file)
  return client.post(`/subtitle/upload/${videoPath}`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
}

// Translation Presets
export interface TranslationPreset {
  id: number
  name: string
  prompt: string
  created_at: string
}

export const listPresets = () =>
  client.get<TranslationPreset[]>('/presets')

export const createPreset = (name: string, prompt: string) =>
  client.post<{ id: number; name: string }>('/presets', { name, prompt })

export const deletePreset = (id: number) =>
  client.delete(`/presets/${id}`)

// Batch Operations
export interface BatchResult {
  job_ids: string[]
  skipped?: string[]
}

export const batchGenerate = (paths: string[], params: Omit<GenerateParams, 'path'>) =>
  client.post<BatchResult>('/subtitle/batch-generate', { paths, ...params })

export const batchTranslate = (paths: string[], params: { target_lang: string; engine: string; preset: string; custom_prompt?: string }) =>
  client.post<BatchResult>('/subtitle/batch-translate', { paths, ...params })

// Delete requests
export interface DeleteRequest {
  id: number
  user_id: number
  username: string
  video_path: string
  subtitle_id: string
  subtitle_label: string
  reason: string
  status: string
  created_at: string
  reviewed_at?: string
  reviewed_by?: number
}

export const requestSubtitleDelete = (videoPath: string, data: { subtitle_id: string; subtitle_label: string; reason: string }) =>
  client.post(`/subtitle/delete-request/${videoPath}`, data)

export const listMyDeleteRequests = () =>
  client.get<DeleteRequest[]>('/subtitle/my-delete-requests')

// Subtitle format conversion — downloads as file
export const convertSubtitle = async (videoPath: string, subtitleId: string, targetFormat: string) => {
  const response = await client.post(`/subtitle/convert/${videoPath}`, {
    subtitle_id: subtitleId,
    target_format: targetFormat,
  }, {
    responseType: 'blob',
  })
  return response
}
