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
}

export const getTree = (path = '') =>
  client.get<TreeResponse>(`/files/tree/${path}`)

export const getFileInfo = (path: string) =>
  client.get<MediaInfo>(`/files/info/${path}`)

export const searchFiles = (query: string) =>
  client.get<{ query: string; results: FileEntry[] }>(`/files/search?q=${encodeURIComponent(query)}`)

export const getThumbnailUrl = (path: string) =>
  `/api/files/thumbnail/${path}`
