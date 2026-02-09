import { useState, useEffect, useRef, useCallback } from 'react'
import { Languages, Loader2, X, Check, AlertCircle, Save, Trash2, Pencil } from 'lucide-react'
import { usePlayerStore } from '@/stores/playerStore'
import {
  translateSubtitle,
  getJob,
  listSubtitles,
  listPresets,
  createPreset,
  updatePreset,
  deletePreset,
  type Job,
  type SubtitleEntry,
  type TranslationPreset,
} from '@/api/subtitle'

const ENGINES = [
  { value: 'gemini', label: 'Gemini' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'deepl', label: 'DeepL' },
]

const BUILT_IN_PRESETS = [
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

interface Props {
  sourceSubtitle: SubtitleEntry
  onClose: () => void
}

export default function SubtitleTranslate({ sourceSubtitle, onClose }: Props) {
  const { currentFile, setSubtitles } = usePlayerStore()
  const [engine, setEngine] = useState('gemini')
  const [targetLang, setTargetLang] = useState('ko')
  const [preset, setPreset] = useState('anime')
  const [customPrompt, setCustomPrompt] = useState('')
  const [savedPresets, setSavedPresets] = useState<TranslationPreset[]>([])
  const [saveName, setSaveName] = useState('')
  const [showSaveInput, setShowSaveInput] = useState(false)
  const [editingPreset, setEditingPreset] = useState(false)
  const [editName, setEditName] = useState('')
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Load saved presets
  useEffect(() => {
    listPresets().then(({ data }) => setSavedPresets(data || [])).catch(() => {})
  }, [])

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

  const handlePresetChange = (value: string) => {
    setPreset(value)
    // If selecting a saved preset, populate the custom prompt
    const saved = savedPresets.find(p => `saved:${p.id}` === value)
    if (saved) {
      setCustomPrompt(saved.prompt)
    } else if (value !== 'custom') {
      setCustomPrompt('')
    }
  }

  const handleSavePreset = async () => {
    if (!saveName.trim() || !customPrompt.trim()) return
    try {
      await createPreset(saveName.trim(), customPrompt.trim())
      const { data } = await listPresets()
      setSavedPresets(data || [])
      setShowSaveInput(false)
      setSaveName('')
    } catch {
      setError('Failed to save preset')
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
      setError('Failed to update preset')
    }
  }

  const handleDeletePreset = async (id: number) => {
    try {
      await deletePreset(id)
      const { data } = await listPresets()
      setSavedPresets(data || [])
      // Reset to anime if current preset was deleted
      if (preset === `saved:${id}`) {
        setPreset('anime')
        setCustomPrompt('')
      }
    } catch {
      setError('Failed to delete preset')
    }
  }

  const handleTranslate = async () => {
    if (!currentFile) return
    setError(null)
    try {
      // Determine actual preset and custom prompt to send
      let actualPreset = preset
      let actualPrompt = customPrompt
      if (preset.startsWith('saved:')) {
        actualPreset = 'custom'
      } else if (preset === 'custom') {
        actualPreset = 'custom'
      } else {
        actualPrompt = ''
      }

      const { data } = await translateSubtitle(currentFile, {
        subtitle_id: sourceSubtitle.id,
        target_lang: targetLang,
        engine,
        preset: actualPreset,
        custom_prompt: actualPrompt || undefined,
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
  const isCustom = preset === 'custom' || preset.startsWith('saved:')

  return (
    <div className="absolute bottom-8 right-0 bg-gray-900/95 border border-gray-700 rounded-lg p-3 min-w-[280px] max-w-[340px] z-50">
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
            <div className="mb-2">
              <label className="text-xs text-gray-400 block mb-0.5">Style Preset</label>
              <select
                value={preset}
                onChange={(e) => handlePresetChange(e.target.value)}
                className="w-full bg-gray-800 text-sm text-white rounded px-2 py-1 border border-gray-600"
              >
                {BUILT_IN_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
                {savedPresets.length > 0 && (
                  <optgroup label="Saved Presets">
                    {savedPresets.map((p) => (
                      <option key={`saved:${p.id}`} value={`saved:${p.id}`}>{p.name}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
          )}

          {/* Custom prompt textarea */}
          {engine !== 'deepl' && isCustom && (
            <div className="mb-2">
              <label className="text-xs text-gray-400 block mb-0.5">Custom Instructions</label>
              <textarea
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="E.g., Use casual speech. Keep honorifics like -san. Localize food names..."
                className="w-full bg-gray-800 text-xs text-white rounded px-2 py-1.5 border border-gray-600 resize-none h-16"
              />
              {/* Save / Edit / Delete preset buttons */}
              <div className="flex items-center gap-1 mt-1">
                {editingPreset ? (
                  /* Editing preset name inline */
                  <div className="flex items-center gap-1 flex-1">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="Preset name"
                      className="flex-1 bg-gray-800 text-xs text-white rounded px-2 py-1 border border-gray-600"
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
                  /* Saving as new preset */
                  <div className="flex items-center gap-1 flex-1">
                    <input
                      type="text"
                      value={saveName}
                      onChange={(e) => setSaveName(e.target.value)}
                      placeholder="Preset name"
                      className="flex-1 bg-gray-800 text-xs text-white rounded px-2 py-1 border border-gray-600"
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
                  /* Default: Save as Preset button */
                  <button
                    onClick={() => setShowSaveInput(true)}
                    disabled={!customPrompt.trim()}
                    className="text-xs text-gray-400 hover:text-primary-400 flex items-center gap-1 disabled:opacity-50"
                  >
                    <Save className="w-3 h-3" />
                    Save as Preset
                  </button>
                )}
                {/* Edit & Delete buttons for saved presets */}
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
