import client from './client'

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

export const getActiveJobs = () =>
  client.get<Job[]>('/jobs/active')

export const getJob = (jobId: string) =>
  client.get<Job>(`/jobs/${jobId}`)

export const listJobs = () =>
  client.get<Job[]>(`/jobs`)

export const cancelJob = (jobId: string) =>
  client.delete(`/jobs/${jobId}`)

export const retryJob = (jobId: string) =>
  client.post(`/jobs/${jobId}/retry`)
