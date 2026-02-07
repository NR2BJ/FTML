import { useState, useEffect, useRef, useCallback } from 'react'
import { Languages, Loader2, X, Check, AlertCircle } from 'lucide-react'
import { usePlayerStore } from '@/stores/playerStore'
import { translateSubtitle, getJob, listSubtitles, type Job, type SubtitleEntry } from '@/api/subtitle'

const ENGINES = [
  { value: 'gemini', label: 'Gemini' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'deepl', label: 'DeepL' },
]

const PRESETS = [
  { value: 'anime', label: 'Anime' },
  { value: 'movie', label: 'Movie / Drama' },
  { value: 'documentary', label: 'Documentary' },
]

const TARGET_LANGS = [
  { value: 'ko', label: 'Korean' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
]

interface Props {
  sourceSubtitle: SubtitleEntry
  onClose: () => void
}

export default function SubtitleTranslate({ sourceSubtitle, onClose }: Props) {
  const { currentFile, setSubtitles } = usePlayerStore()
  const [engine, setEngine] = useState('gemini')
  const [targetLang, setTargetLang] = useState('ko')
  const [preset, setPreset] = useState('anime')
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!jobId) return
    const poll = async () => {
      try {
        const { data } = await getJob(jobId)
        setJob(data)
        if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
          stopPolling()
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

  const handleTranslate = async () => {
    if (!currentFile) return
    setError(null)
    try {
      const { data } = await translateSubtitle(currentFile, {
        subtitle_id: sourceSubtitle.id,
        target_lang: targetLang,
        engine,
        preset,
      })
      setJobId(data.job_id)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to start translation'
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
          <Languages className="w-4 h-4" />
          Translate
        </span>
        <button onClick={onClose} className="text-gray-400 hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="text-xs text-gray-500 mb-2">
        Source: {sourceSubtitle.label}
      </div>

      {!jobId ? (
        <>
          {/* Target Language */}
          <div className="mb-2">
            <label className="text-xs text-gray-400 block mb-0.5">Target Language</label>
            <select
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              className="w-full bg-gray-800 text-sm text-white rounded px-2 py-1 border border-gray-600"
            >
              {TARGET_LANGS.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </div>

          {/* Engine */}
          <div className="mb-2">
            <label className="text-xs text-gray-400 block mb-0.5">Engine</label>
            <select
              value={engine}
              onChange={(e) => setEngine(e.target.value)}
              className="w-full bg-gray-800 text-sm text-white rounded px-2 py-1 border border-gray-600"
            >
              {ENGINES.map((e) => (
                <option key={e.value} value={e.value}>{e.label}</option>
              ))}
            </select>
          </div>

          {/* Preset (only for LLM engines) */}
          {engine !== 'deepl' && (
            <div className="mb-3">
              <label className="text-xs text-gray-400 block mb-0.5">Style Preset</label>
              <select
                value={preset}
                onChange={(e) => setPreset(e.target.value)}
                className="w-full bg-gray-800 text-sm text-white rounded px-2 py-1 border border-gray-600"
              >
                {PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
          )}

          {error && (
            <div className="text-xs text-red-400 mb-2 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {error}
            </div>
          )}

          <button
            onClick={handleTranslate}
            className="w-full bg-primary-600 hover:bg-primary-500 text-white text-sm py-1.5 rounded transition-colors"
          >
            Translate
          </button>
        </>
      ) : (
        <div className="text-center py-2">
          {isProcessing && (
            <>
              <Loader2 className="w-6 h-6 text-primary-400 animate-spin mx-auto mb-2" />
              <div className="text-sm text-gray-300 mb-1">
                {job?.status === 'pending' ? 'Waiting...' : 'Translating...'}
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
              <div className="text-xs text-gray-500 mt-1">Translation added to list</div>
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
