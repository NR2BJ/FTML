import { useEffect, useState } from 'react'
import { getTrackedJobs, type Job } from '@/api/job'
import { workflowFinished } from '@/utils/subtitleTasks'

export function useSubtitleTasks(ids: string[]) {
  const key = ids.join(',')
  const [jobs, setJobs] = useState<Job[]>([])
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    setJobs([])
    setError('')
    if (!key) return
    const roots = key.split(',')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const { data } = await getTrackedJobs(roots, controller.signal)
        if (controller.signal.aborted) return
        setJobs(data || [])
        setError('')
        if (roots.every((id) => workflowFinished(id, data || []))) return
      } catch {
        if (controller.signal.aborted) return
        setError('상태를 읽지 못했습니다. 잠시 후 다시 확인합니다.')
      }
      timer = setTimeout(poll, 2000)
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [key, revision])
  return { jobs, error, refresh: () => setRevision((n) => n + 1) }
}
