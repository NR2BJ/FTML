import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Clock, Trash2, Play } from 'lucide-react'
import { listWatchHistory, deleteWatchHistory, type WatchHistoryEntry } from '@/api/user'

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

function getFileName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

export default function WatchHistory() {
  const [history, setHistory] = useState<WatchHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const fetchHistory = async () => {
    try {
      const { data } = await listWatchHistory()
      setHistory(data)
      setError('')
    } catch {
      setError('Failed to load watch history')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchHistory()
  }, [])

  const handleDelete = async (path: string) => {
    try {
      await deleteWatchHistory(path)
      setHistory((prev) => prev.filter((h) => h.file_path !== path))
    } catch {
      setError('Failed to delete history entry')
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading...</div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex items-center gap-3 mb-6">
        <Clock className="w-6 h-6 text-primary-500" />
        <h1 className="text-xl font-bold text-white">Watch History</h1>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2 rounded-lg text-sm mb-4">
          {error}
        </div>
      )}

      {history.length === 0 ? (
        <div className="bg-dark-900 border border-dark-700 rounded-lg p-8 text-center text-gray-400 text-sm">
          No watch history yet
        </div>
      ) : (
        <div className="space-y-2">
          {history.map((entry) => {
            const progress = entry.duration > 0 ? (entry.position / entry.duration) * 100 : 0

            return (
              <div
                key={entry.file_path}
                className="bg-dark-900 border border-dark-700 rounded-lg p-4 hover:bg-dark-800/50 transition-colors group"
              >
                <div className="flex items-center gap-4">
                  <button
                    onClick={() => navigate(`/watch/${entry.file_path}`)}
                    className="flex-1 text-left min-w-0"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <Play className="w-4 h-4 text-primary-500 flex-shrink-0" />
                      <span className="text-sm text-white truncate">
                        {getFileName(entry.file_path)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex-1 bg-dark-700 rounded-full h-1.5">
                        <div
                          className="bg-primary-500 h-1.5 rounded-full transition-all"
                          style={{ width: `${Math.min(progress, 100)}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-400 flex-shrink-0">
                        {formatDuration(entry.position)} / {formatDuration(entry.duration)}
                      </span>
                    </div>
                  </button>

                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-xs text-gray-500 hidden sm:block">
                      {new Date(entry.updated_at).toLocaleDateString()}
                    </span>
                    <button
                      onClick={() => handleDelete(entry.file_path)}
                      className="text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all p-1"
                      title="Remove from history"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
