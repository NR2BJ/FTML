import { useState, useEffect, useCallback } from 'react'
import {
  Loader2,
  AlertCircle,
  Radio,
  Cpu,
  Zap,
  Download,
  ArrowDownNarrowWide,
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

const QUANT_CONFIG: Record<string, { label: string; color: string }> = {
  int8: { label: 'INT8', color: 'text-cyan-400 bg-cyan-500/10' },
  int4: { label: 'INT4', color: 'text-violet-400 bg-violet-500/10' },
  fp16: { label: 'FP16', color: 'text-amber-400 bg-amber-500/10' },
}

export default function WhisperModelManager() {
  const [models, setModels] = useState<OVWhisperModel[]>([])
  const [gpuInfo, setGpuInfo] = useState<GPUInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activating, setActivating] = useState<string | null>(null)

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

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-400 mb-3 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Model list */}
      <div className="bg-dark-900 border border-dark-700 rounded-lg divide-y divide-dark-700">
        {models.map((model) => {
          const quantCfg = QUANT_CONFIG[model.quant] || QUANT_CONFIG.fp16
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
