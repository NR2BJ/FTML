import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Loader2,
  AlertCircle,
  Radio,
  Cpu,
  Zap,
  Download,
  ArrowDownNarrowWide,
  ChevronDown,
} from 'lucide-react'
import {
  listWhisperModels,
  setActiveModel,
  getGPUInfo,
  type OVWhisperModel,
  type GPUInfo,
} from '@/api/whisperModels'

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  return `${Math.round(bytes / 1_000_000)} MB`
}

const SIZE_OPTIONS: { value: string; label: string }[] = [
  { value: 'tiny', label: 'Tiny' },
  { value: 'base', label: 'Base' },
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large-v3', label: 'Large V3' },
  { value: 'distil-large-v2', label: 'Distil Large V2' },
  { value: 'distil-large-v3', label: 'Distil Large V3' },
]

const QUANT_OPTIONS: { value: string; label: string; color: string }[] = [
  { value: 'int8', label: 'INT8', color: 'text-cyan-400 bg-cyan-500/10' },
  { value: 'int4', label: 'INT4', color: 'text-violet-400 bg-violet-500/10' },
  { value: 'fp16', label: 'FP16', color: 'text-amber-400 bg-amber-500/10' },
]

export default function WhisperModelManager() {
  const [models, setModels] = useState<OVWhisperModel[]>([])
  const [gpuInfo, setGpuInfo] = useState<GPUInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activating, setActivating] = useState<string | null>(null)

  // Filter state
  const [selectedSize, setSelectedSize] = useState('')
  const [selectedQuant, setSelectedQuant] = useState('')
  const [englishOnly, setEnglishOnly] = useState(false)

  const loadModels = useCallback(async () => {
    try {
      const { data } = await listWhisperModels()
      setModels(data || [])
      setError(null)
    } catch {
      setError('Failed to load models from HuggingFace')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadModels()
    getGPUInfo().then(({ data }) => setGpuInfo(data)).catch(() => {})
  }, [loadModels])

  // Compute available sizes from loaded models
  const availableSizes = useMemo(() => {
    const sizes = new Set(models.map(m => m.size))
    return SIZE_OPTIONS.filter(s => sizes.has(s.value))
  }, [models])

  // Compute available quants for selected size
  const availableQuants = useMemo(() => {
    const filtered = selectedSize ? models.filter(m => m.size === selectedSize) : models
    const quants = new Set(filtered.map(m => m.quant))
    return QUANT_OPTIONS.filter(q => quants.has(q.value))
  }, [models, selectedSize])

  // Auto-select first available size if current selection is invalid
  useEffect(() => {
    if (availableSizes.length > 0 && !selectedSize) {
      const defaultSize = availableSizes.find(s => s.value === 'large-v3') || availableSizes[0]
      setSelectedSize(defaultSize.value)
    }
  }, [availableSizes, selectedSize])

  // Reset quant if not available for new size
  useEffect(() => {
    if (selectedQuant && availableQuants.length > 0 && !availableQuants.find(q => q.value === selectedQuant)) {
      setSelectedQuant(availableQuants[0].value)
    }
  }, [availableQuants, selectedQuant])

  // Filter models based on selections
  const filteredModels = useMemo(() => {
    return models.filter(m => {
      if (selectedSize && m.size !== selectedSize) return false
      if (selectedQuant && m.quant !== selectedQuant) return false
      if (englishOnly && !m.english_only) return false
      if (!englishOnly && m.english_only) return false
      return true
    })
  }, [models, selectedSize, selectedQuant, englishOnly])

  // Find the currently active model (regardless of filters)
  const activeModel = useMemo(() => models.find(m => m.active), [models])

  const handleActivate = async (modelId: string) => {
    try {
      setError(null)
      setActivating(modelId)
      await setActiveModel(modelId)
      await loadModels()
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to activate model'
      setError(msg)
    } finally {
      setActivating(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-20">
        <Loader2 className="w-5 h-5 text-gray-400 animate-spin" />
      </div>
    )
  }

  return (
    <div>
      {/* GPU Info */}
      {gpuInfo && gpuInfo.vram_total > 0 && (
        <div className="flex items-center gap-2 text-xs text-gray-400 mb-3 bg-dark-800 border border-dark-700 rounded-lg px-3 py-2">
          <Cpu className="w-3.5 h-3.5 text-primary-400 shrink-0" />
          <span>
            {gpuInfo.device} — {formatBytes(gpuInfo.vram_total)} VRAM
          </span>
        </div>
      )}

      {/* Active model indicator */}
      {activeModel && (
        <div className="flex items-center gap-2 text-xs text-primary-400 mb-3 bg-primary-500/5 border border-primary-500/20 rounded-lg px-3 py-2">
          <Radio className="w-3.5 h-3.5 shrink-0" />
          <span className="text-gray-400">Active:</span>
          <span className="font-medium">{activeModel.label}</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-400 mb-3 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {/* Size dropdown */}
        <div className="relative">
          <select
            value={selectedSize}
            onChange={(e) => setSelectedSize(e.target.value)}
            className="appearance-none bg-dark-800 text-sm text-white rounded-lg pl-3 pr-8 py-1.5 border border-dark-600 focus:outline-none focus:border-primary-500 cursor-pointer"
          >
            <option value="">All Sizes</option>
            {availableSizes.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none" />
        </div>

        {/* Quantization dropdown */}
        <div className="relative">
          <select
            value={selectedQuant}
            onChange={(e) => setSelectedQuant(e.target.value)}
            className="appearance-none bg-dark-800 text-sm text-white rounded-lg pl-3 pr-8 py-1.5 border border-dark-600 focus:outline-none focus:border-primary-500 cursor-pointer"
          >
            <option value="">All Quant</option>
            {availableQuants.map(q => (
              <option key={q.value} value={q.value}>{q.label}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none" />
        </div>

        {/* English-only checkbox */}
        <label className="flex items-center gap-1.5 text-sm text-gray-400 cursor-pointer select-none ml-1">
          <input
            type="checkbox"
            checked={englishOnly}
            onChange={(e) => setEnglishOnly(e.target.checked)}
            className="w-3.5 h-3.5 rounded border-dark-600 bg-dark-800 text-primary-500 focus:ring-primary-500 focus:ring-offset-0 cursor-pointer"
          />
          English only
        </label>

        {/* Result count */}
        <span className="text-xs text-gray-600 ml-auto">
          {filteredModels.length} / {models.length}
        </span>
      </div>

      {/* Model list */}
      <div className="bg-dark-900 border border-dark-700 rounded-lg divide-y divide-dark-700">
        {filteredModels.map((model) => {
          const quantCfg = QUANT_OPTIONS.find(q => q.value === model.quant) || QUANT_OPTIONS[2]
          const isActivating = activating === model.model_id

          return (
            <div key={model.model_id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-200">
                      {model.label}
                    </span>
                    <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded ${quantCfg.color}`}>
                      <Zap className="w-2.5 h-2.5" />
                      {quantCfg.label}
                    </span>
                    {model.english_only && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded text-emerald-400 bg-emerald-500/10">
                        EN
                      </span>
                    )}
                    {model.active && (
                      <span className="inline-flex items-center gap-1 text-xs text-primary-400 bg-primary-500/10 px-1.5 py-0.5 rounded">
                        <Radio className="w-3 h-3" />
                        Active
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5">
                    <span className="text-xs text-gray-500 font-mono">{model.model_id}</span>
                    <span className="inline-flex items-center gap-1 text-[10px] text-gray-500">
                      <ArrowDownNarrowWide className="w-2.5 h-2.5" />
                      {model.downloads.toLocaleString()}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {!model.active && (
                    <button
                      onClick={() => handleActivate(model.model_id)}
                      disabled={isActivating || activating !== null}
                      className="text-xs text-gray-400 hover:text-primary-400 px-2.5 py-1 rounded hover:bg-dark-700 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                      title="Download (if needed) and activate this model"
                    >
                      {isActivating ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Loading...
                        </>
                      ) : (
                        <>
                          <Download className="w-3.5 h-3.5" />
                          Use
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {filteredModels.length === 0 && models.length > 0 && (
        <div className="text-center py-4 text-sm text-gray-500">
          No models match the selected filters.
        </div>
      )}

      {models.length === 0 && (
        <div className="text-center py-4 text-sm text-gray-500">
          No models available. Check your internet connection.
        </div>
      )}

      <p className="text-xs text-gray-600 mt-2">
        Models are automatically downloaded from HuggingFace when activated.
        No container restart needed — the model is swapped at runtime.
      </p>
    </div>
  )
}
