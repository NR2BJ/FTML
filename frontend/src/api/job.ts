import client from './client'
import type { Job } from './subtitle'

export type { Job }

export const getActiveJobs = () =>
  client.get<Job[]>('/jobs/active')

export const cancelJob = (jobId: string) =>
  client.delete(`/jobs/${jobId}`)

export const retryJob = (jobId: string) =>
  client.post(`/jobs/${jobId}/retry`)
