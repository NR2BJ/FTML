import { create } from 'zustand'
import { getActiveJobs, type Job } from '@/api/job'

interface JobState {
  jobs: Job[]
  polling: boolean
  subscribers: number
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
  subscribers: 0,
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
      if (get().subscribers > 0) {
        const interval = hasActive ? ACTIVE_INTERVAL : IDLE_INTERVAL
        const newId = setInterval(() => get().fetchActiveJobs(), interval)
        set({ intervalId: newId })
      } else {
        set({ intervalId: null })
      }
    } catch {
      if (get().subscribers > 0 && !get().intervalId) {
        const newId = setInterval(() => get().fetchActiveJobs(), IDLE_INTERVAL)
        set({ intervalId: newId })
      }
    }
  },

  startPolling: () => {
    const nextSubscribers = get().subscribers + 1
    set({ polling: true, subscribers: nextSubscribers })
    if (nextSubscribers === 1) {
      get().fetchActiveJobs()
    }
  },

  stopPolling: () => {
    const nextSubscribers = Math.max(0, get().subscribers - 1)
    if (nextSubscribers > 0) {
      set({ subscribers: nextSubscribers, polling: true })
      return
    }
    const { intervalId } = get()
    if (intervalId) {
      clearInterval(intervalId)
    }
    set({ polling: false, subscribers: 0, intervalId: null })
  },
}))
