import client from './client'

export interface FileEntry {
  name: string
  path: string
  is_dir: boolean
  size?: number
  children?: FileEntry[]
}

export interface TreeResponse {
  path: string
  entries: FileEntry[]
}

export interface AudioStreamInfo {
  index: number          // absolute stream index in the file
  stream_index: number   // audio-only index (0, 1, 2...)
  codec_name: string
  channels: number
  channel_layout?: string
  sample_rate?: string
  bit_rate?: string
  language?: string
  title?: string
}

export interface MediaInfo {
  duration: string
  size: string
  bit_rate: string
  video_codec: string
  audio_codec: string
  width: number
  height: number
  frame_rate: string
  streams: any[]
  audio_streams?: AudioStreamInfo[]
}

export const getTree = (path = '') =>
  client.get<TreeResponse>(`/files/tree/${path}`)

export const getFileInfo = (path: string) =>
  client.get<MediaInfo>(`/files/info/${path}`)

export const searchFiles = (query: string) =>
  client.get<{ query: string; results: FileEntry[] }>(`/files/search?q=${encodeURIComponent(query)}`)

export const getThumbnailUrl = (path: string) => {
  const token = localStorage.getItem('token') || ''
  return `/api/files/thumbnail/${encodeURI(path)}?token=${encodeURIComponent(token)}`
}

export interface BatchInfoResult {
  path: string
  info: MediaInfo | null
}

export const batchFileInfo = (paths: string[]) =>
  client.post<BatchInfoResult[]>('/files/batch-info', { paths })
