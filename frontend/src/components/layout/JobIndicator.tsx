import { useState, useEffect, useRef } from 'react'
import { useJobStore } from '@/stores/jobStore'
import { cancelJob } from '@/api/job'
import {
  Loader2, CheckCircle2, XCircle, Clock, X, RefreshCw,
  Languages, Mic
} from 'lucide-react'

function formatElapsed(startedAt?: string) {
  if (!startedAt) return ''
  const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)
  if (elapsed < 60) return `${elapsed}s`
  const min = Math.floor(elapsed / 60)
  const sec = elapsed % 60
  return `${min}m ${sec}s`
}

function shortFileName(filePath: string) {
  const parts = filePath.split('/')
  const name = parts[parts.length - 1]
  // Truncate long names
  if (name.length > 40) return name.slice(0, 37) + '...'
  return name
}

export default function JobIndicator() {
  const { jobs, startPolling } = useJobStore()
  const [open, setOpen] = useState(false)
  const [, setTick] = useState(0)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Start polling on mount
  useEffect(() => {
    startPolling()
  }, [startPolling])

  // Tick every second for elapsed time updates
  const activeJobs = jobs.filter(j => j.status === 'pending' || j.status === 'running')
  useEffect(() => {
    if (activeJobs.length === 0) return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [activeJobs.length])

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Don't render if no jobs at all
  if (jobs.length === 0) return null

  const hasActive = activeJobs.length > 0

  const handleCancel = async (jobId: string) => {
    try {
      await cancelJob(jobId)
      useJobStore.getState().fetchActiveJobs()
    } catch {
      // ignore
    }
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className="relative text-gray-400 hover:text-white transition-colors"
        title={hasActive ? `${activeJobs.length} active job(s)` : 'Jobs'}
      >
        {hasActive ? (
          <Loader2 className="w-5 h-5 animate-spin text-primary-400" />
        ) : (
          <CheckCircle2 className="w-5 h-5 text-green-400" />
        )}
        {hasActive && (
          <span className="absolute -top-1 -right-1 bg-primary-500 text-white text-[9px] font-bold rounded-full w-3.5 h-3.5 flex items-center justify-center">
            {activeJobs.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-dark-800 border border-dark-700 rounded-lg shadow-xl z-50 py-1 max-h-96 overflow-auto">
          <div className="px-3 py-2 border-b border-dark-700 flex items-center justify-between">
            <span className="text-sm font-medium text-white">Jobs</span>
            <button
              onClick={() => useJobStore.getState().fetchActiveJobs()}
              className="text-gray-400 hover:text-white transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>

          {jobs.length === 0 ? (
            <div className="px-3 py-4 text-sm text-gray-500 text-center">
              No active jobs
            </div>
          ) : (
            jobs.map(job => (
              <div key={job.id} className="px-3 py-2 border-b border-dark-700/50 last:border-0">
                <div className="flex items-start gap-2">
                  {/* Icon */}
                  <div className="mt-0.5 shrink-0">
                    {job.type === 'transcribe' ? (
                      <Mic className="w-3.5 h-3.5 text-blue-400" />
                    ) : (
                      <Languages className="w-3.5 h-3.5 text-purple-400" />
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-gray-300 truncate" title={job.file_path}>
                      {shortFileName(job.file_path)}
                    </div>

                    <div className="flex items-center gap-1.5 mt-0.5">
                      {/* Status */}
                      {job.status === 'running' && (
                        <>
                          <Loader2 className="w-3 h-3 text-primary-400 animate-spin" />
                          <span className="text-[10px] text-primary-400">
                            {job.type === 'transcribe' ? 'Transcribing' : 'Translating'}
                          </span>
                        </>
                      )}
                      {job.status === 'pending' && (
                        <>
                          <Clock className="w-3 h-3 text-yellow-400" />
                          <span className="text-[10px] text-yellow-400">Pending</span>
                        </>
                      )}
                      {job.status === 'completed' && (
                        <>
                          <CheckCircle2 className="w-3 h-3 text-green-400" />
                          <span className="text-[10px] text-green-400">Completed</span>
                        </>
                      )}
                      {job.status === 'failed' && (
                        <>
                          <XCircle className="w-3 h-3 text-red-400" />
                          <span className="text-[10px] text-red-400">Failed</span>
                        </>
                      )}

                      {/* Elapsed time */}
                      {(job.status === 'running' || job.status === 'pending') && job.started_at && (
                        <span className="text-[10px] text-gray-500 ml-auto">
                          {formatElapsed(job.started_at)}
                        </span>
                      )}
                    </div>

                    {/* Progress bar */}
                    {(job.status === 'running' || job.status === 'pending') && (
                      <div className="mt-1 bg-dark-700 rounded-full h-1 overflow-hidden">
                        <div
                          className="h-full bg-primary-500 rounded-full transition-all duration-500"
                          style={{ width: `${Math.max(job.progress * 100, 2)}%` }}
                        />
                      </div>
                    )}

                    {/* Error message */}
                    {job.status === 'failed' && job.error && (
                      <div className="text-[10px] text-red-400/70 mt-0.5 truncate" title={job.error}>
                        {job.error}
                      </div>
                    )}
                  </div>

                  {/* Cancel button */}
                  {(job.status === 'running' || job.status === 'pending') && (
                    <button
                      onClick={() => handleCancel(job.id)}
                      className="shrink-0 text-gray-500 hover:text-red-400 transition-colors mt-0.5"
                      title="Cancel"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
