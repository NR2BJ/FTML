import { encodeMediaPath } from '@/utils/mediaPath'
import client from './client'
export type { Job } from './job'

export interface SubtitleEntry {
  id: string
  label: string
  language: string
  type: 'embedded' | 'external' | 'generated'
  format: string
}

export interface GenerateParams {
  observe_speech?: boolean
  audio_track?: number
  engine: string   // Whisper 연결 식별자
  model?: string
  language: string // "auto" | "ko" | "en" | "ja" etc.
}

export interface TranslateParams {
  subtitle_id: string
  target_lang: string
  engine: 'gemini'
  preset: string   // "anime" | "movie" | "documentary" | "custom"
  custom_prompt?: string
}

export type SubtitleTaskMode = 'generate' | 'translate' | 'generate-translate'
export interface SubtitleTaskItem { path: string; job_id?: string; subtitle_id?: string; reason?: string }
export const submitSubtitleTasks = (request: {
  paths: string[]; mode: SubtitleTaskMode; generate: GenerateParams; translate?: TranslateParams
}) => client.post<{items: SubtitleTaskItem[]; job_ids: string[]; skipped: string[]}>('/subtitle/tasks', request)

export const listSubtitles = (path: string, signal?: AbortSignal) =>
  client.get<SubtitleEntry[]>(`/subtitle/list/${encodeMediaPath(path)}`, { signal, timeout: 15000 })

export const getSubtitleUrl = (videoPath: string, subtitleId: string, native = false) =>
  `/api/subtitle/content/${encodeMediaPath(videoPath)}?id=${encodeURIComponent(subtitleId)}${native ? '&mode=native' : ''}`

export const getSubtitleFontsUrl = (path: string) => `/api/subtitle/fonts/${encodeMediaPath(path)}`
export const getSubtitleFontUrl = (path: string, font: number | 'default') =>
  `/api/subtitle/font/${encodeMediaPath(path)}?font=${font}`

export const deleteSubtitle = (path: string, subtitleId: string) =>
  client.delete(`/subtitle/delete/${encodeMediaPath(path)}?id=${encodeURIComponent(subtitleId)}`)

export const uploadSubtitle = (videoPath: string, file: File) => {
  const formData = new FormData()
  formData.append('file', file)
  return client.post(`/subtitle/upload/${encodeMediaPath(videoPath)}`, formData, {
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

export const updatePreset = (id: number, name: string, prompt: string) =>
  client.put(`/presets/${id}`, { name, prompt })

export const deletePreset = (id: number) =>
  client.delete(`/presets/${id}`)

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
  client.post(`/subtitle/delete-request/${encodeMediaPath(videoPath)}`, data)

export const listMyDeleteRequests = () =>
  client.get<DeleteRequest[]>('/subtitle/my-delete-requests')

// Subtitle format conversion — downloads as file
export const convertSubtitle = async (videoPath: string, subtitleId: string, targetFormat: string) => {
  const response = await client.post(`/subtitle/convert/${encodeMediaPath(videoPath)}`, {
    subtitle_id: subtitleId,
    target_format: targetFormat,
  }, {
    responseType: 'blob',
  })
  return response
}
