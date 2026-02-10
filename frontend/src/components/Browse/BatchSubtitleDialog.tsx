import { useState, useEffect, useRef, useCallback } from 'react'
import {
  X,
  Loader2,
  Check,
  AlertCircle,
  Subtitles,
  Languages,
  Sparkles,
  RotateCcw,
  Save,
  Trash2,
  Pencil,
} from 'lucide-react'
import { type FileEntry } from '@/api/files'
import {
  batchGenerate,
  batchTranslate,
  batchGenerateTranslate,
  translateSubtitle,
  getJob,
  retryJob,
  listPresets,
  createPreset,
  updatePreset,
  deletePreset,
  type Job,
  type TranslationPreset,
} from '@/api/subtitle'
import { listAvailableEngines, type AvailableEngine } from '@/api/whisperBackends'
import { isVideoFile } from '@/utils/format'

const ENGINES_TRANSLATE = [
  { value: 'gemini', label: 'Gemini' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'deepl', label: 'DeepL' },
]

const PRESETS = [
  { value: 'anime', label: 'Anime' },
  { value: 'movie', label: 'Movie / Drama' },
  { value: 'documentary', label: 'Documentary' },
  { value: 'custom', label: 'Custom Prompt' },
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

type Mode = 'generate' | 'translate' | 'generate-translate'

interface BatchSubtitleDialogProps {
  mode: Mode
  files: FileEntry[]
  subtitleId?: string
  onClose: () => void
}

interface JobStatus {
  id: string
  path: string
  status: string
  progress: number
  error?: string
}

export default function BatchSubtitleDialog({ mode, files, subtitleId, onClose }: BatchSubtitleDialogProps) {
  const videoFiles = files.filter(f => !f.is_dir && isVideoFile(f.name))
  const videoPaths = videoFiles.map(f => f.path)

  // Available whisper engines (loaded from backend)
  const [whisperEngines, setWhisperEngines] = useState<AvailableEngine[]>([])

  // Generate options
  const [genEngine, setGenEngine] = useState('')
  const [genLanguage, setGenLanguage] = useState('auto')

  // Translate options
  const [transEngine, setTransEngine] = useState('gemini')
  const [targetLang, setTargetLang] = useState('ko')
  const [preset, setPreset] = useState('anime')
  const [customPrompt, setCustomPrompt] = useState('')
  const [savedPresets, setSavedPresets] = useState<TranslationPreset[]>([])
  const [saveName, setSaveName] = useState('')
  const [showSaveInput, setShowSaveInput] = useState(false)
  const [editingPreset, setEditingPreset] = useState(false)
  const [editName, setEditName] = useState('')
  const [presetError, setPresetError] = useState<string | null>(null)

  // Job tracking
  const [jobs, setJobs] = useState<JobStatus[]>([])
  const [phase, setPhase] = useState<'config' | 'running' | 'done'>('config')
  const [skipped, setSkipped] = useState<string[]>([])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Load available whisper engines
  useEffect(() => {
    if (mode === 'generate' || mode === 'generate-translate') {
      listAvailableEngines()
        .then(({ data }) => {
          setWhisperEngines(data || [])
          if (data && data.length > 0) setGenEngine(data[0].value)
        })
        .catch(() => setWhisperEngines([]))
    }
  }, [mode])

  // Load saved presets
  useEffect(() => {
    if (mode !== 'generate') {
      listPresets().then(({ data }) => setSavedPresets(data || [])).catch(() => {})
    }
  }, [mode])

  const handleSavePreset = async () => {
    if (!saveName.trim() || !customPrompt.trim()) return
    try {
      await createPreset(saveName.trim(), customPrompt.trim())
      const { data } = await listPresets()
      setSavedPresets(data || [])
      setShowSaveInput(false)
      setSaveName('')
    } catch {
      setPresetError('Failed to save preset')
    }
  }

  const handleUpdatePreset = async () => {
    const id = parseInt(preset.replace('saved:', ''))
    if (isNaN(id) || !editName.trim() || !customPrompt.trim()) return
    try {
      await updatePreset(id, editName.trim(), customPrompt.trim())
      const { data } = await listPresets()
      setSavedPresets(data || [])
      setEditingPreset(false)
      setEditName('')
    } catch {
      setPresetError('Failed to update preset')
    }
  }

  const handleDeletePreset = async (id: number) => {
    try {
      await deletePreset(id)
      const { data } = await listPresets()
      setSavedPresets(data || [])
      if (preset === `saved:${id}`) {
        setPreset('anime')
        setCustomPrompt('')
      }
    } catch {
      setPresetError('Failed to delete preset')
    }
  }

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => {
    return stopPolling
  }, [stopPolling])

  // Poll job statuses
  useEffect(() => {
    if (phase !== 'running' || jobs.length === 0) return

    const poll = async () => {
      const updates = await Promise.allSettled(
        jobs.filter(j => j.status === 'pending' || j.status === 'running').map(async (j) => {
          const { data } = await getJob(j.id)
          return data
        })
      )

      setJobs(prev => {
        const next = [...prev]
        updates.forEach(result => {
          if (result.status === 'fulfilled') {
            const data = result.value
            const idx = next.findIndex(j => j.id === data.id)
            if (idx >= 0) {
              next[idx] = { ...next[idx], status: data.status, progress: data.progress, error: data.error }
            }
          }
        })

        // Check if all done
        const allDone = next.every(j => ['completed', 'failed', 'cancelled'].includes(j.status))
        if (allDone) {
          stopPolling()
          // If this was generate phase of generate-translate, start translate phase
          // For now, just mark as done
          setPhase('done')
        }

        return next
      })
    }

    pollRef.current = setInterval(poll, 2000)
    // Initial poll after a short delay
    const timeout = setTimeout(poll, 1000)
    return () => {
      stopPolling()
      clearTimeout(timeout)
    }
  }, [phase, jobs.length, stopPolling])

  const handleStart = async () => {
    setPhase('running')

    try {
      if (mode === 'generate-translate') {
        let actualPreset = preset
        let actualPrompt = customPrompt
        if (preset.startsWith('saved:')) {
          actualPreset = 'custom'
        } else if (preset !== 'custom') {
          actualPrompt = ''
        }

        const { data } = await batchGenerateTranslate(
          videoPaths,
          { engine: genEngine, model: '', language: genLanguage },
          {
            target_lang: targetLang,
            engine: transEngine,
            preset: actualPreset,
            custom_prompt: actualPrompt || undefined,
          }
        )
        const jobStatuses: JobStatus[] = data.job_ids.map((id, i) => ({
          id,
          path: videoPaths[i] || '',
          status: 'pending',
          progress: 0,
        }))
        setJobs(jobStatuses)
        setSkipped(data.skipped || [])
      } else if (mode === 'generate') {
        const { data } = await batchGenerate(videoPaths, {
          engine: genEngine,
          model: '',
          language: genLanguage,
        })
        const jobStatuses: JobStatus[] = data.job_ids.map((id, i) => ({
          id,
          path: videoPaths[i] || '',
          status: 'pending',
          progress: 0,
        }))
        setJobs(jobStatuses)
        setSkipped(data.skipped || [])
      } else if (mode === 'translate') {
        let actualPreset = preset
        let actualPrompt = customPrompt
        if (preset.startsWith('saved:')) {
          actualPreset = 'custom'
        } else if (preset === 'custom') {
          actualPreset = 'custom'
        } else {
          actualPrompt = ''
        }

        // Single file with specific subtitle_id → use translateSubtitle API
        if (subtitleId && videoPaths.length === 1) {
          const { data } = await translateSubtitle(videoPaths[0], {
            subtitle_id: subtitleId,
            target_lang: targetLang,
            engine: transEngine,
            preset: actualPreset,
            custom_prompt: actualPrompt || undefined,
          })
          setJobs([{
            id: data.job_id,
            path: videoPaths[0],
            status: 'pending',
            progress: 0,
          }])
        } else {
          const { data } = await batchTranslate(videoPaths, {
            target_lang: targetLang,
            engine: transEngine,
            preset: actualPreset,
            custom_prompt: actualPrompt || undefined,
          })
          const jobStatuses: JobStatus[] = data.job_ids.map((id, i) => ({
            id,
            path: videoPaths[i] || '',
            status: 'pending',
            progress: 0,
          }))
          setJobs(jobStatuses)
          setSkipped(data.skipped || [])
        }
      }
    } catch (err) {
      console.error('Batch operation failed:', err)
      setPhase('config')
    }
  }

  const handleRetry = async (jobId: string) => {
    try {
      await retryJob(jobId)
      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: 'pending', progress: 0, error: undefined } : j))
      if (phase === 'done') setPhase('running')
    } catch {
      // ignore
    }
  }

  const completedCount = jobs.filter(j => j.status === 'completed').length
  const failedCount = jobs.filter(j => j.status === 'failed').length
  const totalProgress = jobs.length > 0
    ? jobs.reduce((sum, j) => sum + (j.status === 'completed' ? 1 : j.progress), 0) / jobs.length
    : 0

  const modeLabel = mode === 'generate' ? 'Generate Subtitles'
    : mode === 'translate' ? 'Translate Subtitles'
    : 'Generate & Translate'

  const ModeIcon = mode === 'generate' ? Subtitles
    : mode === 'translate' ? Languages
    : Sparkles

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-dark-900 border border-dark-700 rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-dark-700">
          <div className="flex items-center gap-2">
            <ModeIcon className="w-5 h-5 text-primary-400" />
            <h3 className="text-sm font-medium text-white">{modeLabel}</h3>
            <span className="text-xs text-gray-500">({videoFiles.length} files)</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {phase === 'config' && (
            <div className="space-y-3">
              {/* Generate options */}
              {(mode === 'generate' || mode === 'generate-translate') && (
                <>
                  <div>
                    <label className="text-xs text-gray-400 block mb-1">Whisper Engine</label>
                    <select
                      value={genEngine}
                      onChange={(e) => setGenEngine(e.target.value)}
                      className="w-full bg-dark-800 text-sm text-white rounded px-2 py-1.5 border border-dark-600"
                    >
                      {whisperEngines.map(e => (
                        <option key={e.value} value={e.value}>{e.label}</option>
                      ))}
                    </select>
                    {whisperEngines.length === 0 && (
                      <p className="text-[10px] text-amber-400 mt-0.5">No backends configured. Add one in Settings.</p>
                    )}
                  </div>
                  <div>
                    <label className="text-xs text-gray-400 block mb-1">Language</label>
                    <select
                      value={genLanguage}
                      onChange={(e) => setGenLanguage(e.target.value)}
                      className="w-full bg-dark-800 text-sm text-white rounded px-2 py-1.5 border border-dark-600"
                    >
                      <option value="auto">Auto Detect</option>
                      {TARGET_LANGS.map(l => (
                        <option key={l.value} value={l.value}>{l.label}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              {/* Translate options */}
              {(mode === 'translate' || mode === 'generate-translate') && (
                <>
                  {mode === 'generate-translate' && (
                    <div className="border-t border-dark-700 pt-3 mt-3">
                      <span className="text-xs font-medium text-gray-400">Translation Options</span>
                    </div>
                  )}
                  <div>
                    <label className="text-xs text-gray-400 block mb-1">Target Language</label>
                    <select
                      value={targetLang}
                      onChange={(e) => setTargetLang(e.target.value)}
                      className="w-full bg-dark-800 text-sm text-white rounded px-2 py-1.5 border border-dark-600"
                    >
                      {TARGET_LANGS.map(l => (
                        <option key={l.value} value={l.value}>{l.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-400 block mb-1">Translation Engine</label>
                    <select
                      value={transEngine}
                      onChange={(e) => setTransEngine(e.target.value)}
                      className="w-full bg-dark-800 text-sm text-white rounded px-2 py-1.5 border border-dark-600"
                    >
                      {ENGINES_TRANSLATE.map(e => (
                        <option key={e.value} value={e.value}>{e.label}</option>
                      ))}
                    </select>
                  </div>
                  {transEngine !== 'deepl' && (
                    <div>
                      <label className="text-xs text-gray-400 block mb-1">Style Preset</label>
                      <select
                        value={preset}
                        onChange={(e) => {
                          setPreset(e.target.value)
                          const saved = savedPresets.find(p => `saved:${p.id}` === e.target.value)
                          if (saved) setCustomPrompt(saved.prompt)
                          else if (e.target.value !== 'custom') setCustomPrompt('')
                        }}
                        className="w-full bg-dark-800 text-sm text-white rounded px-2 py-1.5 border border-dark-600"
                      >
                        {PRESETS.map(p => (
                          <option key={p.value} value={p.value}>{p.label}</option>
                        ))}
                        {savedPresets.length > 0 && (
                          <optgroup label="Saved Presets">
                            {savedPresets.map(p => (
                              <option key={`saved:${p.id}`} value={`saved:${p.id}`}>{p.name}</option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    </div>
                  )}
                  {transEngine !== 'deepl' && (preset === 'custom' || preset.startsWith('saved:')) && (
                    <div>
                      <label className="text-xs text-gray-400 block mb-1">Custom Instructions</label>
                      <textarea
                        value={customPrompt}
                        onChange={(e) => setCustomPrompt(e.target.value)}
                        placeholder="E.g., Use casual speech..."
                        className="w-full bg-dark-800 text-xs text-white rounded px-2 py-1.5 border border-dark-600 resize-none h-16"
                      />
                      {/* Save / Edit / Delete preset buttons */}
                      <div className="flex items-center gap-1 mt-1">
                        {editingPreset ? (
                          <div className="flex items-center gap-1 flex-1">
                            <input
                              type="text"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              placeholder="Preset name"
                              className="flex-1 bg-dark-800 text-xs text-white rounded px-2 py-1 border border-dark-600"
                              onKeyDown={(e) => e.key === 'Enter' && handleUpdatePreset()}
                              autoFocus
                            />
                            <button
                              onClick={handleUpdatePreset}
                              disabled={!editName.trim() || !customPrompt.trim()}
                              className="text-xs text-primary-400 hover:text-primary-300 disabled:opacity-50"
                              title="Save changes"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => { setEditingPreset(false); setEditName('') }}
                              className="text-xs text-gray-400 hover:text-gray-300"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : showSaveInput ? (
                          <div className="flex items-center gap-1 flex-1">
                            <input
                              type="text"
                              value={saveName}
                              onChange={(e) => setSaveName(e.target.value)}
                              placeholder="Preset name"
                              className="flex-1 bg-dark-800 text-xs text-white rounded px-2 py-1 border border-dark-600"
                              onKeyDown={(e) => e.key === 'Enter' && handleSavePreset()}
                              autoFocus
                            />
                            <button
                              onClick={handleSavePreset}
                              disabled={!saveName.trim()}
                              className="text-xs text-primary-400 hover:text-primary-300 disabled:opacity-50"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => { setShowSaveInput(false); setSaveName('') }}
                              className="text-xs text-gray-400 hover:text-gray-300"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setShowSaveInput(true)}
                            disabled={!customPrompt.trim()}
                            className="text-xs text-gray-400 hover:text-primary-400 flex items-center gap-1 disabled:opacity-50"
                          >
                            <Save className="w-3 h-3" />
                            Save as Preset
                          </button>
                        )}
                        {preset.startsWith('saved:') && !editingPreset && !showSaveInput && (
                          <div className="flex items-center gap-1 ml-auto">
                            <button
                              onClick={() => {
                                const saved = savedPresets.find(p => `saved:${p.id}` === preset)
                                if (saved) {
                                  setEditingPreset(true)
                                  setEditName(saved.name)
                                }
                              }}
                              className="text-xs text-gray-500 hover:text-primary-400"
                              title="Edit this preset"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => {
                                const id = parseInt(preset.replace('saved:', ''))
                                if (!isNaN(id)) handleDeletePreset(id)
                              }}
                              className="text-xs text-gray-500 hover:text-red-400"
                              title="Delete this preset"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </div>
                      {presetError && (
                        <div className="text-xs text-red-400 mt-1 flex items-center gap-1">
                          <AlertCircle className="w-3 h-3" />
                          {presetError}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {(phase === 'running' || phase === 'done') && (
            <div className="space-y-3">
              {/* Overall progress */}
              <div>
                <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                  <span>
                    {phase === 'done' ? 'Complete' : 'Processing...'}
                  </span>
                  <span>
                    {completedCount}/{jobs.length} done
                    {failedCount > 0 && <span className="text-red-400 ml-1">({failedCount} failed)</span>}
                  </span>
                </div>
                <div className="h-2 bg-dark-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      phase === 'done' ? 'bg-green-500' : 'bg-primary-500'
                    }`}
                    style={{ width: `${Math.round(totalProgress * 100)}%` }}
                  />
                </div>
              </div>

              {/* Skipped files */}
              {skipped.length > 0 && (
                <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1.5">
                  {skipped.length} file(s) skipped (no subtitles found for translation)
                </div>
              )}

              {/* Individual job statuses */}
              <div className="max-h-48 overflow-y-auto space-y-1">
                {jobs.map((j) => {
                  const filename = j.path.split('/').pop() || j.path
                  return (
                    <div key={j.id} className="flex items-center gap-2 text-xs py-1 px-2 rounded bg-dark-800">
                      {j.status === 'completed' ? (
                        <Check className="w-3.5 h-3.5 text-green-400 shrink-0" />
                      ) : j.status === 'failed' ? (
                        <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                      ) : (
                        <Loader2 className="w-3.5 h-3.5 text-primary-400 animate-spin shrink-0" />
                      )}
                      <span className="text-gray-300 truncate flex-1" title={j.path}>
                        {filename}
                      </span>
                      <span className="text-gray-500 shrink-0">
                        {j.status === 'completed' ? 'Done' :
                         j.status === 'failed' ? 'Failed' :
                         `${Math.round(j.progress * 100)}%`}
                      </span>
                      {j.status === 'failed' && (
                        <button
                          onClick={() => handleRetry(j.id)}
                          className="text-primary-400 hover:text-primary-300 shrink-0 ml-1"
                          title="Retry"
                        >
                          <RotateCcw className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-dark-700 flex justify-end gap-2">
          {phase === 'config' && (
            <>
              <button
                onClick={onClose}
                className="text-sm text-gray-400 hover:text-white px-3 py-1.5 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleStart}
                disabled={videoFiles.length === 0 || ((mode === 'generate' || mode === 'generate-translate') && whisperEngines.length === 0)}
                className="text-sm bg-primary-600 hover:bg-primary-500 text-white px-4 py-1.5 rounded transition-colors disabled:opacity-50"
              >
                Start ({videoFiles.length} files)
              </button>
            </>
          )}
          {phase === 'running' && (
            <button
              onClick={onClose}
              className="text-sm text-gray-400 hover:text-white px-3 py-1.5 rounded transition-colors"
            >
              Close (jobs continue in background)
            </button>
          )}
          {phase === 'done' && (
            <button
              onClick={onClose}
              className="text-sm bg-primary-600 hover:bg-primary-500 text-white px-4 py-1.5 rounded transition-colors"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
