import { useState, useEffect, useRef, useCallback } from 'react'
import { Wand2, Loader2, X, Check, AlertCircle } from 'lucide-react'
import { usePlayerStore } from '@/stores/playerStore'
import { generateSubtitle, getJob, listSubtitles, type Job } from '@/api/subtitle'
import { listAvailableEngines, type AvailableEngine } from '@/api/whisperBackends'

const MODELS = [
  { value: 'large-v3', label: 'Large V3 (Best)' },
  { value: 'medium', label: 'Medium' },
  { value: 'small', label: 'Small' },
  { value: 'base', label: 'Base' },
  { value: 'tiny', label: 'Tiny (Fast)' },
]

const LANGUAGES = [
  { value: 'auto', label: 'Auto Detect' },
  { value: 'ko', label: 'Korean' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
]

interface Props {
  onClose: () => void
}

export default function SubtitleGenerate({ onClose }: Props) {
  const { currentFile, setSubtitles } = usePlayerStore()
  const [engines, setEngines] = useState<AvailableEngine[]>([])
  const [engine, setEngine] = useState('')
  const [model, setModel] = useState('large-v3')
  const [language, setLanguage] = useState('auto')
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Load available engines
  useEffect(() => {
    listAvailableEngines()
      .then(({ data }) => {
        setEngines(data || [])
        if (data && data.length > 0) setEngine(data[0].value)
      })
      .catch(() => setEngines([]))
  }, [])

  const selectedType = engines.find(e => e.value === engine)?.type

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  // Poll job status
  useEffect(() => {
    if (!jobId) return
    const poll = async () => {
      try {
        const { data } = await getJob(jobId)
        setJob(data)
        if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
          stopPolling()
          // Refresh subtitle list on completion
          if (data.status === 'completed' && currentFile) {
            const { data: subs } = await listSubtitles(currentFile)
            setSubtitles(subs || [])
          }
        }
      } catch {
        stopPolling()
      }
    }
    poll()
    pollRef.current = setInterval(poll, 2000)
    return stopPolling
  }, [jobId, currentFile, setSubtitles, stopPolling])

  const handleGenerate = async () => {
    if (!currentFile) return
    setError(null)
    try {
      const { data } = await generateSubtitle(currentFile, { engine, model, language })
      setJobId(data.job_id)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to start generation'
      setError(msg)
    }
  }

  const isProcessing = job && (job.status === 'pending' || job.status === 'running')
  const isDone = job?.status === 'completed'
  const isFailed = job?.status === 'failed'

  return (
    <div className="absolute bottom-8 right-0 bg-gray-900/95 border border-gray-700 rounded-lg p-3 min-w-[240px] z-50">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-white flex items-center gap-1.5">
          <Wand2 className="w-4 h-4" />
          Generate Subtitles
        </span>
        <button onClick={onClose} className="text-gray-400 hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>

      {!jobId ? (
        <>
          {/* Engine */}
          <div className="mb-2">
            <label className="text-xs text-gray-400 block mb-0.5">Engine</label>
            <select
              value={engine}
              onChange={(e) => setEngine(e.target.value)}
              className="w-full bg-gray-800 text-sm text-white rounded px-2 py-1 border border-gray-600"
            >
              {engines.map((e) => (
                <option key={e.value} value={e.value}>{e.label}</option>
              ))}
            </select>
            {engines.length === 0 && (
              <p className="text-[10px] text-amber-400 mt-0.5">No backends configured. Add one in Settings.</p>
            )}
          </div>

          {/* Model (only for non-openai engines) */}
          {selectedType !== 'openai' && (
            <div className="mb-2">
              <label className="text-xs text-gray-400 block mb-0.5">Model</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full bg-gray-800 text-sm text-white rounded px-2 py-1 border border-gray-600"
              >
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* Language */}
          <div className="mb-3">
            <label className="text-xs text-gray-400 block mb-0.5">Language</label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-full bg-gray-800 text-sm text-white rounded px-2 py-1 border border-gray-600"
            >
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </div>

          {error && (
            <div className="text-xs text-red-400 mb-2 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {error}
            </div>
          )}

          <button
            onClick={handleGenerate}
            disabled={!engine || engines.length === 0}
            className="w-full bg-primary-600 hover:bg-primary-500 disabled:opacity-50 text-white text-sm py-1.5 rounded transition-colors"
          >
            Generate
          </button>
        </>
      ) : (
        <div className="text-center py-2">
          {isProcessing && (
            <>
              <Loader2 className="w-6 h-6 text-primary-400 animate-spin mx-auto mb-2" />
              <div className="text-sm text-gray-300 mb-1">
                {job?.status === 'pending' ? 'Waiting...' : 'Transcribing...'}
              </div>
              {job && job.progress > 0 && (
                <div className="w-full bg-gray-700 rounded-full h-1.5 mb-1">
                  <div
                    className="bg-primary-500 h-1.5 rounded-full transition-all"
                    style={{ width: `${Math.round(job.progress * 100)}%` }}
                  />
                </div>
              )}
              <div className="text-xs text-gray-500">
                {Math.round((job?.progress || 0) * 100)}%
              </div>
            </>
          )}
          {isDone && (
            <>
              <Check className="w-6 h-6 text-green-400 mx-auto mb-2" />
              <div className="text-sm text-green-400">Complete!</div>
              <div className="text-xs text-gray-500 mt-1">Subtitles added to list</div>
            </>
          )}
          {isFailed && (
            <>
              <AlertCircle className="w-6 h-6 text-red-400 mx-auto mb-2" />
              <div className="text-sm text-red-400">Failed</div>
              <div className="text-xs text-gray-500 mt-1">{job?.error}</div>
              <button
                onClick={() => { setJobId(null); setJob(null) }}
                className="mt-2 text-xs text-primary-400 hover:text-primary-300"
              >
                Try Again
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
