import client from './client'

export interface Job {
  id: string
  parent_id?: string
  retry_of?: string
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

export const getActiveJobs = () => client.get<Job[]>('/jobs/active')

export const cancelJob = (jobId: string) => client.delete(`/jobs/${jobId}`)

export const retryJob = (jobId: string) =>
  client.post<{ job_id: string }>(`/jobs/${jobId}/retry`)

export const getTrackedJobs = (ids: string[], signal?: AbortSignal) =>
  client.get<Job[]>('/jobs/tracked', {
    params: { ids: ids.join(',') },
    signal,
    timeout: 15000,
  })

export interface VideoJobHistory {
  file_path: string
  total: number
  completed: number
  failed: number
  active: number
  last_created_at: string
}

export interface HistoryPage<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export const getVideoJobHistory = (
  q: string,
  status: string,
  page: number,
  signal?: AbortSignal
) =>
  client.get<HistoryPage<VideoJobHistory>>('/jobs/videos', {
    params: { q, status, page },
    signal,
    timeout: 15000,
  })

export const getJobHistory = (
  path: string,
  page: number,
  signal?: AbortSignal
) =>
  client.get<HistoryPage<Job>>('/jobs/history', {
    params: { path, page },
    signal,
    timeout: 15000,
  })
