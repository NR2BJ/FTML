import client from './client'

export interface SubtitleEntry {
  id: string
  label: string
  language: string
  type: 'embedded' | 'external'
  format: string
}

export const listSubtitles = (path: string) =>
  client.get<SubtitleEntry[]>(`/subtitle/list/${path}`)

const getToken = () => localStorage.getItem('token') || ''

export const getSubtitleUrl = (videoPath: string, subtitleId: string) =>
  `/api/subtitle/content/${videoPath}?id=${encodeURIComponent(subtitleId)}&token=${getToken()}`
