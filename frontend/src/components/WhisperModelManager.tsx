import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Download,
  Trash2,
  CheckCircle2,
  Loader2,
  HardDrive,
  AlertCircle,
  AlertTriangle,
  Radio,
  Cpu,
  Zap,
} from 'lucide-react'
import {
  listWhisperModels,
  downloadWhisperModel,
  getDownloadProgress,
  setActiveModel,
  deleteWhisperModel,
  getGPUInfo,
  type WhisperModel,
  type GPUInfo,
} from '@/api/whisperModels'

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  return `${Math.round(bytes / 1_000_000)} MB`
}

export default function WhisperModelManager() {
  const [models, setModels] = useState<WhisperModel[]>([])
  const [gpuInfo, setGpuInfo] = useState<GPUInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<Set<string>>(new Set())
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const pollTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({})

  const loadModels = useCallback(async () => {
    try {
      const { data } = await listWhisperModels()
      setModels(data)
      setError(null)

      // Check if any models are currently downloading (progress > 0 but not downloaded)
      const currentlyDownloading = new Set<string>()
      for (const m of data) {
        if (m.progress && m.progress > 0 && m.progress < 1 && !m.downloaded) {
          currentlyDownloading.add(m.name)
        }
      }
      if (currentlyDownloading.size > 0) {
        setDownloading(prev => {
          const next = new Set(prev)
          currentlyDownloading.forEach(n => next.add(n))
          return next
        })
        // Start polling for in-progress downloads
        currentlyDownloading.forEach(name => startPolling(name))
      }
    } catch {
      setError('Failed to load models')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadModels()
    // Load GPU info
    getGPUInfo().then(({ data }) => setGpuInfo(data)).catch(() => {})
    return () => {
      // Cleanup all poll timers
      Object.values(pollTimers.current).forEach(clearInterval)
    }
  }, [loadModels])

  const startPolling = (modelName: string) => {
    // Don't start if already polling
    if (pollTimers.current[modelName]) return

    pollTimers.current[modelName] = setInterval(async () => {
      try {
        const { data: progress } = await getDownloadProgress(modelName)

        // Update the model's progress in state
        setModels(prev =>
          prev.map(m =>
            m.name === modelName
              ? { ...m, progress: progress.progress, downloaded: progress.done && !progress.error }
              : m
          )
        )

        if (progress.done) {
          clearInterval(pollTimers.current[modelName])
          delete pollTimers.current[modelName]
          setDownloading(prev => {
            const next = new Set(prev)
            next.delete(modelName)
            return next
          })

          if (progress.error) {
            setError(`Download failed for ${modelName}: ${progress.error}`)
          } else {
            // Reload full model list to get accurate state
            loadModels()
          }
        }
      } catch {
        // Ignore polling errors, will retry
      }
    }, 1500)
  }

  const handleDownload = async (modelName: string) => {
    try {
      setError(null)
      await downloadWhisperModel(modelName)
      setDownloading(prev => new Set(prev).add(modelName))
      startPolling(modelName)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Download failed'
      setError(msg)
    }
  }

  const handleDelete = async (modelName: string) => {
    try {
      setError(null)
      setActionLoading(modelName)
      await deleteWhisperModel(modelName)
      await loadModels()
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Delete failed'
      setError(msg)
    } finally {
      setActionLoading(null)
    }
  }

  const handleSetActive = async (modelName: string) => {
    try {
      setError(null)
      setActionLoading(modelName)
      await setActiveModel(modelName)
      await loadModels()
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to set active model'
      setError(msg)
    } finally {
      setActionLoading(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="w-5 h-5 text-gray-400 animate-spin" />
      </div>
    )
  }

  // Separate full-precision and quantized models
  const fullModels = models.filter(m => !m.quantized)
  const quantizedModels = models.filter(m => m.quantized)

  const renderModel = (model: WhisperModel) => {
    const isDownloading = downloading.has(model.name)
    const isActionLoading = actionLoading === model.name
    const progress = model.progress || 0
    const vramWarning = model.fits_vram === false

    return (
      <div key={model.name} className="px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-gray-200">
                {model.label}
              </span>
              <span className="text-xs text-gray-500">{model.size}</span>
              {model.quantized && (
                <span className="inline-flex items-center gap-1 text-xs text-violet-400 bg-violet-500/10 px-1.5 py-0.5 rounded">
                  <Zap className="w-3 h-3" />
                  Quantized
                </span>
              )}
              {model.active && (
                <span className="inline-flex items-center gap-1 text-xs text-primary-400 bg-primary-500/10 px-1.5 py-0.5 rounded">
                  <Radio className="w-3 h-3" />
                  Active
                </span>
              )}
              {model.downloaded && !model.active && (
                <span className="inline-flex items-center gap-1 text-xs text-green-400">
                  <CheckCircle2 className="w-3 h-3" />
                  Ready
                </span>
              )}
              {vramWarning && (
                <span
                  className="inline-flex items-center gap-1 text-xs text-amber-400"
                  title={`Requires ~${formatBytes(model.vram_required)} VRAM${gpuInfo ? `, your GPU has ${formatBytes(gpuInfo.vram_total)}` : ''}`}
                >
                  <AlertTriangle className="w-3 h-3" />
                  VRAM
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              {model.description}
              {vramWarning && (
                <span className="text-amber-500/80 ml-1">
                  — needs ~{formatBytes(model.vram_required)} VRAM
                </span>
              )}
            </p>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {isDownloading ? (
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 text-primary-400 animate-spin" />
                <span className="text-xs text-primary-400 w-10 text-right">
                  {Math.round(progress * 100)}%
                </span>
              </div>
            ) : model.downloaded ? (
              <>
                {!model.active && (
                  <button
                    onClick={() => handleSetActive(model.name)}
                    disabled={isActionLoading}
                    className="text-xs text-gray-400 hover:text-primary-400 px-2 py-1 rounded hover:bg-dark-700 transition-colors disabled:opacity-50"
                    title="Set as active model"
                  >
                    {isActionLoading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      'Use'
                    )}
                  </button>
                )}
                {!model.active && (
                  <button
                    onClick={() => handleDelete(model.name)}
                    disabled={isActionLoading}
                    className="text-gray-500 hover:text-red-400 p-1 rounded hover:bg-dark-700 transition-colors disabled:opacity-50"
                    title="Delete model"
                  >
                    {isActionLoading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                  </button>
                )}
              </>
            ) : (
              <button
                onClick={() => handleDownload(model.name)}
                className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-primary-400 px-2 py-1 rounded hover:bg-dark-700 transition-colors"
                title="Download model"
              >
                <Download className="w-3.5 h-3.5" />
                Download
              </button>
            )}
          </div>
        </div>

        {/* Download progress bar */}
        {isDownloading && (
          <div className="mt-2 h-1.5 bg-dark-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary-500 rounded-full transition-all duration-300"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        )}
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

      {/* Full-precision models */}
      <div className="bg-dark-900 border border-dark-700 rounded-lg divide-y divide-dark-700">
        {fullModels.map(renderModel)}
      </div>

      {/* Quantized models */}
      {quantizedModels.length > 0 && (
        <>
          <h4 className="text-xs font-medium text-gray-400 mt-4 mb-2 flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-violet-400" />
            Quantized Models
            <span className="text-gray-600 font-normal">— smaller, less VRAM</span>
          </h4>
          <div className="bg-dark-900 border border-dark-700 rounded-lg divide-y divide-dark-700">
            {quantizedModels.map(renderModel)}
          </div>
        </>
      )}

      <p className="text-xs text-gray-600 mt-2 flex items-center gap-1.5">
        <HardDrive className="w-3 h-3" />
        Models are downloaded from HuggingFace and stored in the shared Docker volume.
        After changing the active model, restart the whisper container:
        <code className="text-gray-500 bg-dark-800 px-1 rounded">docker compose restart whisper-sycl</code>
      </p>
    </div>
  )
}
