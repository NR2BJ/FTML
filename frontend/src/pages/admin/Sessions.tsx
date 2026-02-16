import { useState, useEffect } from 'react'
import { Monitor, RefreshCw, Pause, Play } from 'lucide-react'
import { listSessions, type StreamSession } from '@/api/admin'

function formatTimeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return `${hours}h ${mins % 60}m ago`
}

function fileName(path: string) {
  return path.split('/').pop() || path
}

export default function Sessions() {
  const [sessions, setSessions] = useState<StreamSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchSessions = async () => {
    try {
      const { data } = await listSessions()
      setSessions(data || [])
      setError('')
    } catch {
      setError('Failed to load sessions')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchSessions()
    const SESSIONS_REFRESH_INTERVAL_MS = 10000
    const interval = setInterval(fetchSessions, SESSIONS_REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading...</div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Monitor className="w-6 h-6 text-primary-500" />
          <h1 className="text-xl font-bold text-white">Active Sessions</h1>
          <span className="text-sm text-gray-400">({sessions.length})</span>
        </div>
        <button
          onClick={() => { setLoading(true); fetchSessions() }}
          className="text-gray-400 hover:text-white transition-colors"
          title="Refresh"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2 rounded-lg text-sm mb-4">
          {error}
        </div>
      )}

      {sessions.length === 0 ? (
        <div className="text-center text-gray-500 py-16">
          <Monitor className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p>No active streaming sessions</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {sessions.map((s) => (
            <div key={s.id} className="bg-dark-900 border border-dark-700 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  {s.paused ? (
                    <Pause className="w-4 h-4 text-yellow-400 shrink-0" />
                  ) : (
                    <Play className="w-4 h-4 text-green-400 shrink-0" fill="currentColor" />
                  )}
                  <span className="text-sm text-white truncate" title={s.input_path}>
                    {fileName(s.input_path)}
                  </span>
                </div>
                <span className="text-xs text-gray-500 shrink-0 ml-2">
                  {s.id.slice(0, 8)}
                </span>
              </div>
              <div className="flex items-center gap-4 text-xs text-gray-400">
                <span>{s.quality}</span>
                <span>{s.codec}</span>
                <span>Heartbeat: {formatTimeAgo(s.last_heartbeat)}</span>
                <span>Started: {formatTimeAgo(s.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
