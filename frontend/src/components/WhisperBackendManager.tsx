import { useState, useEffect } from 'react'
import {
  Plus,
  Trash2,
  Activity,
  Loader2,
  Check,
  X,
  AlertCircle,
  Cpu,
  Zap,
  Eye,
  Cloud,
  Server,
} from 'lucide-react'
import {
  listWhisperBackends,
  createWhisperBackend,
  updateWhisperBackend,
  deleteWhisperBackend,
  healthCheckBackend,
  type WhisperBackend,
  type HealthResult,
} from '@/api/whisperBackends'

const TYPE_CONFIG: Record<string, { label: string; color: string; icon: typeof Cpu }> = {
  sycl: { label: 'SYCL', color: 'text-blue-400 bg-blue-500/10 border-blue-500/20', icon: Zap },
  openvino: { label: 'OpenVINO', color: 'text-violet-400 bg-violet-500/10 border-violet-500/20', icon: Eye },
  cuda: { label: 'CUDA', color: 'text-green-400 bg-green-500/10 border-green-500/20', icon: Zap },
  cpu: { label: 'CPU', color: 'text-gray-400 bg-gray-500/10 border-gray-500/20', icon: Cpu },
  openai: { label: 'OpenAI', color: 'text-orange-400 bg-orange-500/10 border-orange-500/20', icon: Cloud },
}

const BACKEND_TYPES = [
  { value: 'sycl', label: 'SYCL (Intel Arc)' },
  { value: 'openvino', label: 'OpenVINO (Intel)' },
  { value: 'cuda', label: 'CUDA (NVIDIA)' },
  { value: 'cpu', label: 'CPU' },
  { value: 'openai', label: 'OpenAI (Cloud)' },
]

export default function WhisperBackendManager() {
  const [backends, setBackends] = useState<WhisperBackend[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [healthResults, setHealthResults] = useState<Record<number, HealthResult | 'loading'>>({})

  // Add form state
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState('sycl')
  const [newURL, setNewURL] = useState('')
  const [addError, setAddError] = useState<string | null>(null)

  // Edit state
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editURL, setEditURL] = useState('')

  const loadBackends = async () => {
    try {
      const { data } = await listWhisperBackends()
      setBackends(data || [])
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadBackends()
  }, [])

  const handleAdd = async () => {
    setAddError(null)
    if (!newName.trim()) {
      setAddError('Name is required')
      return
    }
    if (newType !== 'openai' && !newURL.trim()) {
      setAddError('URL is required for local backends')
      return
    }

    try {
      await createWhisperBackend({
        name: newName.trim(),
        backend_type: newType,
        url: newType === 'openai' ? '' : newURL.trim(),
      })
      setNewName('')
      setNewType('sycl')
      setNewURL('')
      setShowAdd(false)
      loadBackends()
    } catch {
      setAddError('Failed to add backend')
    }
  }

  const handleDelete = async (id: number) => {
    try {
      await deleteWhisperBackend(id)
      setBackends(prev => prev.filter(b => b.id !== id))
    } catch {
      // ignore
    }
  }

  const handleToggle = async (backend: WhisperBackend) => {
    try {
      await updateWhisperBackend(backend.id, { enabled: !backend.enabled })
      setBackends(prev =>
        prev.map(b => (b.id === backend.id ? { ...b, enabled: !b.enabled } : b))
      )
    } catch {
      // ignore
    }
  }

  const handleHealthCheck = async (id: number) => {
    setHealthResults(prev => ({ ...prev, [id]: 'loading' }))
    try {
      const { data } = await healthCheckBackend(id)
      setHealthResults(prev => ({ ...prev, [id]: data }))
    } catch {
      setHealthResults(prev => ({ ...prev, [id]: { ok: false, error: 'Request failed' } }))
    }
  }

  const handleEditSave = async (backend: WhisperBackend) => {
    try {
      await updateWhisperBackend(backend.id, {
        name: editName,
        url: backend.backend_type === 'openai' ? '' : editURL,
      })
      setBackends(prev =>
        prev.map(b => (b.id === backend.id ? { ...b, name: editName, url: editURL } : b))
      )
      setEditingId(null)
    } catch {
      // ignore
    }
  }

  const startEdit = (backend: WhisperBackend) => {
    setEditingId(backend.id)
    setEditName(backend.name)
    setEditURL(backend.url)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-20">
        <Loader2 className="w-5 h-5 text-gray-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/* Backend list */}
      {backends.map((backend) => {
        const typeConfig = TYPE_CONFIG[backend.backend_type] || TYPE_CONFIG.cpu
        const TypeIcon = typeConfig.icon
        const health = healthResults[backend.id]
        const isEditing = editingId === backend.id

        return (
          <div
            key={backend.id}
            className={`bg-dark-900 border rounded-lg px-3 py-2.5 ${
              backend.enabled ? 'border-dark-700' : 'border-dark-800 opacity-60'
            }`}
          >
            {isEditing ? (
              /* Edit mode */
              <div className="space-y-2">
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full bg-dark-800 text-sm text-white rounded px-2 py-1.5 border border-dark-600 focus:outline-none focus:border-primary-500"
                  placeholder="Backend name"
                />
                {backend.backend_type !== 'openai' && (
                  <input
                    type="text"
                    value={editURL}
                    onChange={(e) => setEditURL(e.target.value)}
                    className="w-full bg-dark-800 text-sm text-white rounded px-2 py-1.5 border border-dark-600 focus:outline-none focus:border-primary-500"
                    placeholder="http://whisper-sycl:8178"
                  />
                )}
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setEditingId(null)}
                    className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => handleEditSave(backend)}
                    className="text-xs bg-primary-600 hover:bg-primary-500 text-white px-3 py-1 rounded"
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              /* View mode */
              <div className="flex items-center gap-2">
                {/* Type badge */}
                <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border ${typeConfig.color}`}>
                  <TypeIcon className="w-3 h-3" />
                  {typeConfig.label}
                </span>

                {/* Name */}
                <span className="text-sm text-white font-medium flex-1 truncate">
                  {backend.name}
                </span>

                {/* URL (for local backends) */}
                {backend.backend_type !== 'openai' && (
                  <span className="text-xs text-gray-500 truncate max-w-[180px] hidden sm:block">
                    {backend.url}
                  </span>
                )}
                {backend.backend_type === 'openai' && (
                  <span className="text-xs text-gray-500">Cloud API</span>
                )}

                {/* Health indicator */}
                {health && health !== 'loading' && (
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      health.ok ? 'bg-green-400' : 'bg-red-400'
                    }`}
                    title={health.ok ? `OK (${health.latency_ms}ms)` : health.error}
                  />
                )}
                {health === 'loading' && (
                  <Loader2 className="w-3 h-3 text-gray-400 animate-spin shrink-0" />
                )}

                {/* Health check button */}
                <button
                  onClick={() => handleHealthCheck(backend.id)}
                  className="text-gray-500 hover:text-primary-400 transition-colors p-1"
                  title="Test connection"
                >
                  <Activity className="w-3.5 h-3.5" />
                </button>

                {/* Toggle enabled */}
                <button
                  onClick={() => handleToggle(backend)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
                    backend.enabled ? 'bg-primary-600' : 'bg-dark-600'
                  }`}
                  title={backend.enabled ? 'Disable' : 'Enable'}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      backend.enabled ? 'translate-x-4' : 'translate-x-1'
                    }`}
                  />
                </button>

                {/* Edit */}
                <button
                  onClick={() => startEdit(backend)}
                  className="text-gray-500 hover:text-white transition-colors p-1"
                  title="Edit"
                >
                  <Server className="w-3.5 h-3.5" />
                </button>

                {/* Delete */}
                <button
                  onClick={() => handleDelete(backend.id)}
                  className="text-gray-500 hover:text-red-400 transition-colors p-1"
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )
      })}

      {backends.length === 0 && !showAdd && (
        <div className="text-center py-4 text-sm text-gray-500">
          No whisper backends registered. Add one to enable subtitle generation.
        </div>
      )}

      {/* Add form */}
      {showAdd ? (
        <div className="bg-dark-900 border border-primary-500/30 rounded-lg px-3 py-3 space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="flex-1 bg-dark-800 text-sm text-white rounded px-2 py-1.5 border border-dark-600 focus:outline-none focus:border-primary-500"
              placeholder="Name (e.g. Arc A380 SYCL)"
              autoFocus
            />
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              className="bg-dark-800 text-sm text-white rounded px-2 py-1.5 border border-dark-600"
            >
              {BACKEND_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          {newType !== 'openai' && (
            <input
              type="text"
              value={newURL}
              onChange={(e) => setNewURL(e.target.value)}
              className="w-full bg-dark-800 text-sm text-white rounded px-2 py-1.5 border border-dark-600 focus:outline-none focus:border-primary-500"
              placeholder="http://whisper-sycl:8178"
            />
          )}
          {addError && (
            <div className="text-xs text-red-400 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {addError}
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => { setShowAdd(false); setAddError(null) }}
              className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded"
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              className="text-xs bg-primary-600 hover:bg-primary-500 text-white px-3 py-1 rounded flex items-center gap-1"
            >
              <Check className="w-3 h-3" />
              Add
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="w-full border border-dashed border-dark-600 hover:border-primary-500 rounded-lg py-2 text-sm text-gray-400 hover:text-primary-400 transition-colors flex items-center justify-center gap-1.5"
        >
          <Plus className="w-4 h-4" />
          Add Backend
        </button>
      )}
    </div>
  )
}
