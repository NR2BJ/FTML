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

export interface ChapterInfo {
  title: string
  start_time: number
  end_time: number
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
  pix_fmt?: string
  container?: string
  streams: any[]
  audio_streams?: AudioStreamInfo[]
  chapters?: ChapterInfo[]
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

// File management (Admin only)
export const uploadFile = (path: string, file: File, onProgress?: (pct: number) => void) => {
  const formData = new FormData()
  formData.append('file', file)
  return client.post(`/files/upload/${path}`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: onProgress
      ? (e) => onProgress(Math.round((e.loaded * 100) / (e.total || 1)))
      : undefined,
  })
}

export const deleteFile = (path: string) =>
  client.delete(`/files/delete/${path}`)

export const moveFile = (source: string, destination: string) =>
  client.put('/files/move', { source, destination })

export const createFolder = (path: string) =>
  client.post(`/files/mkdir/${path}`)

export interface SiblingsResponse {
  current: string
  dir: string
  files: string[]
}

export const getSiblings = (path: string) =>
  client.get<SiblingsResponse>(`/files/siblings/${path}`)

// Trash management (Admin only)
export interface TrashEntry {
  name: string
  original_path: string
  deleted_at: string
  deleted_by: string
  is_dir: boolean
  size: number
}

export const listTrash = () =>
  client.get<TrashEntry[]>('/files/trash')

export const restoreTrash = (name: string) =>
  client.post('/files/trash/restore', { name })

export const permanentDeleteTrash = (name: string) =>
  client.delete(`/files/trash/${encodeURIComponent(name)}`)

export const emptyTrash = () =>
  client.delete('/files/trash/empty')
