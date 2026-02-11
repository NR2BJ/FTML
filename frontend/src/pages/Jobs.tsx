import { useState, useEffect } from 'react'
import { useJobStore } from '@/stores/jobStore'
import { cancelJob, retryJob } from '@/api/job'
import type { Job } from '@/api/job'
import {
  formatElapsed, estimateRemaining, formatDurationBetween,
  timeAgo, shortFileName,
} from '@/utils/format'
import {
  Loader2, CheckCircle2, XCircle, Clock, X, RefreshCw,
  Languages, Mic, Briefcase, RotateCcw, AlertCircle
} from 'lucide-react'

// ─── Helpers ────────────────────────────────────────────────

function getJobParams(job: Job): string[] {
  const p = job.params || {}
  if (job.type === 'transcribe') {
    return ['engine', 'model', 'language']
      .filter(k => p[k])
      .map(k => `${k}: ${p[k]}`)
  }
  const tags: string[] = ['engine', 'preset']
    .filter(k => p[k])
    .map(k => `${k}: ${p[k]}`)
  if (p.source_lang && p.target_lang) tags.push(`${p.source_lang} → ${p.target_lang}`)
  else if (p.target_lang) tags.push(`→ ${p.target_lang}`)
  return tags
}

// ─── Sub-components ─────────────────────────────────────────

function StatCard({ icon: Icon, label, value, color }: {
  icon: React.ElementType
  label: string
  value: number
  color: string
}) {
  return (
    <div className="bg-dark-900 border border-dark-700 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon className={`w-4 h-4 ${color}`} />
        <span className="text-xs text-gray-500 uppercase tracking-wide">{label}</span>
      </div>
      <p className="text-2xl font-semibold text-white">{value}</p>
    </div>
  )
}

function ActiveJobCard({ job, onCancel }: { job: Job; onCancel: (id: string) => void }) {
  const pct = Math.round(job.progress * 100)
  const params = getJobParams(job)
  const isTranscribe = job.type === 'transcribe'
  const isPending = job.status === 'pending'

  return (
    <div className="bg-dark-900 border border-dark-700 rounded-lg p-4">
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {isTranscribe ? (
            <Mic className="w-4 h-4 text-blue-400" />
          ) : (
            <Languages className="w-4 h-4 text-purple-400" />
          )}
          <span className="text-sm font-medium text-white">
            {isPending ? 'Pending' : isTranscribe ? 'Transcribing' : 'Translating'}
          </span>
          {isPending && (
            <Clock className="w-3.5 h-3.5 text-yellow-400" />
          )}
          {!isPending && (
            <Loader2 className="w-3.5 h-3.5 text-primary-400 animate-spin" />
          )}
        </div>
        <button
          onClick={() => onCancel(job.id)}
          className="text-gray-500 hover:text-red-400 transition-colors p-1 rounded hover:bg-dark-800"
          title="Cancel"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* File name */}
      <div className="text-sm text-gray-300 mb-3 truncate" title={job.file_path}>
        {shortFileName(job.file_path)}
      </div>

      {/* Progress bar */}
      <div className="mb-2">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-gray-400">Progress</span>
          <span className="text-xs font-medium text-white">{pct}%</span>
        </div>
        <div className="h-3 bg-dark-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-primary-500 rounded-full transition-all duration-500"
            style={{ width: `${Math.max(pct, 1)}%` }}
          />
        </div>
      </div>

      {/* Time info */}
      <div className="flex items-center gap-3 text-xs text-gray-500 mb-2">
        {job.started_at && (
          <span>Elapsed: {formatElapsed(job.started_at)}</span>
        )}
        {(() => {
          const eta = estimateRemaining(job.started_at, job.progress)
          return eta ? <span>ETA: {eta}</span> : null
        })()}
      </div>

      {/* Params */}
      {params.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {params.map((p, i) => (
            <span key={i} className="text-[10px] bg-dark-800 text-gray-400 border border-dark-600 rounded px-1.5 py-0.5">
              {p}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function RecentJobRow({ job, onRetry }: { job: Job; onRetry: (id: string) => void }) {
  const isTranscribe = job.type === 'transcribe'
  const isFailed = job.status === 'failed'
  const duration = formatDurationBetween(job.started_at, job.completed_at)

  return (
    <div className="px-3 py-2.5 border-b border-dark-700/50 last:border-0 hover:bg-dark-800/30 transition-colors">
      <div className="flex items-center gap-3">
        {/* Status icon */}
        <div className="shrink-0">
          {isFailed ? (
            <XCircle className="w-4 h-4 text-red-400" />
          ) : job.status === 'cancelled' ? (
            <X className="w-4 h-4 text-gray-500" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-green-400" />
          )}
        </div>

        {/* Type icon */}
        <div className="shrink-0">
          {isTranscribe ? (
            <Mic className="w-3.5 h-3.5 text-blue-400/60" />
          ) : (
            <Languages className="w-3.5 h-3.5 text-purple-400/60" />
          )}
        </div>

        {/* File name */}
        <div className="flex-1 min-w-0 text-sm text-gray-300 truncate" title={job.file_path}>
          {shortFileName(job.file_path)}
        </div>

        {/* Duration */}
        {duration && !isFailed && (
          <span className="shrink-0 text-xs text-gray-600">{duration}</span>
        )}

        {/* Time ago */}
        <span className="shrink-0 text-xs text-gray-600 w-16 text-right">
          {timeAgo(job.completed_at)}
        </span>

        {/* Retry button */}
        {isFailed && (
          <button
            onClick={() => onRetry(job.id)}
            className="shrink-0 text-gray-500 hover:text-primary-400 transition-colors p-1 rounded hover:bg-dark-800"
            title="Retry"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Error message for failed jobs */}
      {isFailed && job.error && (
        <div className="mt-1.5 ml-[3.25rem] text-xs text-red-400/70 break-words">
          {job.error}
        </div>
      )}
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────

export default function Jobs() {
  const { jobs, startPolling } = useJobStore()
  const [, setTick] = useState(0)

  // Start polling on mount
  useEffect(() => {
    startPolling()
  }, [startPolling])

  // Tick every second for elapsed time / ETA updates
  const activeJobs = jobs.filter(j => j.status === 'pending' || j.status === 'running')
  useEffect(() => {
    if (activeJobs.length === 0) return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [activeJobs.length])

  const completedJobs = jobs.filter(j => j.status === 'completed')
  const failedJobs = jobs.filter(j => j.status === 'failed')
  const recentJobs = jobs.filter(j => j.status !== 'pending' && j.status !== 'running')

  const handleCancel = async (jobId: string) => {
    try {
      await cancelJob(jobId)
      useJobStore.getState().fetchActiveJobs()
    } catch {
      // ignore
    }
  }

  const handleRetry = async (jobId: string) => {
    try {
      await retryJob(jobId)
      useJobStore.getState().fetchActiveJobs()
    } catch {
      // ignore
    }
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Briefcase className="w-6 h-6 text-gray-400" />
          <h1 className="text-xl font-semibold text-white">Jobs</h1>
        </div>
        <button
          onClick={() => useJobStore.getState().fetchActiveJobs()}
          className="text-gray-400 hover:text-white transition-colors"
          title="Refresh"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <StatCard icon={Loader2} label="Active" value={activeJobs.length} color="text-primary-400" />
        <StatCard icon={CheckCircle2} label="Completed" value={completedJobs.length} color="text-green-400" />
        <StatCard icon={XCircle} label="Failed" value={failedJobs.length} color="text-red-400" />
      </div>

      {/* Active Jobs */}
      {activeJobs.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Active Jobs
          </h2>
          <div className="space-y-3">
            {activeJobs.map(job => (
              <ActiveJobCard key={job.id} job={job} onCancel={handleCancel} />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {jobs.length === 0 && (
        <div className="bg-dark-900 border border-dark-700 rounded-lg p-12 text-center">
          <AlertCircle className="w-8 h-8 text-gray-600 mx-auto mb-3" />
          <p className="text-sm text-gray-500">No jobs yet</p>
          <p className="text-xs text-gray-600 mt-1">Jobs will appear here when you generate or translate subtitles</p>
        </div>
      )}

      {/* Recent Jobs */}
      {recentJobs.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">
            Recent Jobs
          </h2>
          <div className="bg-dark-900 border border-dark-700 rounded-lg overflow-hidden">
            {recentJobs.map(job => (
              <RecentJobRow key={job.id} job={job} onRetry={handleRetry} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
