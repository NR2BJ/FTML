import { encodeMediaPath } from '@/utils/mediaPath'
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
  client.get<TreeResponse>(`/files/tree/${encodeMediaPath(path)}`)

export const getFileInfo = (path: string) =>
  client.get<MediaInfo>(`/files/info/${encodeMediaPath(path)}`)

export const searchFiles = (query: string, signal?: AbortSignal) =>
  client.get<{ query: string; results: FileEntry[] }>('/files/search', {
    params: { q: query },
    signal,
  })

export const getThumbnailUrl = (path: string) =>
  `/api/files/thumbnail/${encodeMediaPath(path)}`

export interface BatchInfoResult {
  path: string
  info: MediaInfo | null
}

export const batchFileInfo = (paths: string[]) =>
  client.post<BatchInfoResult[]>('/files/batch-info', { paths })

export interface SiblingsResponse {
  current: string
  dir: string
  files: string[]
}

export const getSiblings = (path: string) =>
  client.get<SiblingsResponse>(`/files/siblings/${encodeMediaPath(path)}`)
