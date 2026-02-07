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

export const getJob = (jobId: string) =>
  client.get<Job>(`/jobs/${jobId}`)

export const listJobs = () =>
  client.get<Job[]>(`/jobs`)

export const cancelJob = (jobId: string) =>
  client.delete(`/jobs/${jobId}`)
