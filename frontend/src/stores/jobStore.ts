import { create } from 'zustand'
import { getActiveJobs, type Job } from '@/api/job'

interface JobState {
  jobs: Job[]
  polling: boolean
  intervalId: ReturnType<typeof setInterval> | null
  fetchActiveJobs: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
}

const ACTIVE_INTERVAL = 3000   // 3s when jobs are active
const IDLE_INTERVAL = 30000    // 30s when no active jobs

export const useJobStore = create<JobState>((set, get) => ({
  jobs: [],
  polling: false,
  intervalId: null,

  fetchActiveJobs: async () => {
    try {
      const { data } = await getActiveJobs()
      const jobs = data || []
      set({ jobs })

      // Adjust polling interval based on active jobs
      const hasActive = jobs.some(j => j.status === 'pending' || j.status === 'running')
      const { intervalId } = get()
      if (intervalId) {
        clearInterval(intervalId)
      }
      const interval = hasActive ? ACTIVE_INTERVAL : IDLE_INTERVAL
      const newId = setInterval(() => get().fetchActiveJobs(), interval)
      set({ intervalId: newId })
    } catch {
      // ignore — server might be unreachable
    }
  },

  startPolling: () => {
    if (get().polling) return
    set({ polling: true })
    get().fetchActiveJobs()
  },

  stopPolling: () => {
    const { intervalId } = get()
    if (intervalId) {
      clearInterval(intervalId)
    }
    set({ polling: false, intervalId: null })
  },
}))
