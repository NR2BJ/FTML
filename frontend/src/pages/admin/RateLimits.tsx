import { useState, useEffect } from 'react'
import { getRateLimitStatus, clearAllRateLimits, clearRateLimitForIP, type RateLimitStatus } from '@/api/admin'
import { useToastStore } from '@/stores/toastStore'
import { ShieldAlert, Trash2, RefreshCw, Loader2, XCircle } from 'lucide-react'

export default function RateLimits() {
  const [status, setStatus] = useState<RateLimitStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const addToast = useToastStore((s) => s.addToast)

  const loadStatus = async () => {
    try {
      const { data } = await getRateLimitStatus()
      setStatus(data)
    } catch {
      addToast({ type: 'error', message: 'Failed to load rate limit status' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadStatus()
    const STATUS_REFRESH_INTERVAL_MS = 10000
    const interval = setInterval(loadStatus, STATUS_REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [])

  const handleClearAll = async () => {
    try {
      await clearAllRateLimits()
      addToast({ type: 'success', message: 'All rate limits cleared' })
      loadStatus()
    } catch {
      addToast({ type: 'error', message: 'Failed to clear rate limits' })
    }
  }

  const handleClearIP = async (ip: string) => {
    try {
      await clearRateLimitForIP(ip)
      addToast({ type: 'success', message: `Rate limit cleared for ${ip}` })
      loadStatus()
    } catch {
      addToast({ type: 'error', message: `Failed to clear rate limit for ${ip}` })
    }
  }

  const formatTimeLeft = (resetAt: string) => {
    const diff = new Date(resetAt).getTime() - Date.now()
    if (diff <= 0) return 'expired'
    const secs = Math.ceil(diff / 1000)
    return `${secs}s`
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ShieldAlert className="w-6 h-6 text-gray-400" />
          <h1 className="text-xl font-semibold text-white">Rate Limits</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadStatus}
            className="text-gray-400 hover:text-white transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          {status && status.entries.length > 0 && (
            <button
              onClick={handleClearAll}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-lg text-sm transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear All
            </button>
          )}
        </div>
      </div>

      {/* Policy info */}
      {status && (
        <div className="bg-dark-900 border border-dark-700 rounded-lg p-4 mb-4">
          <div className="flex items-center gap-4 text-sm text-gray-400">
            <span>Limit: <span className="text-white font-medium">{status.limit} req</span></span>
            <span>Window: <span className="text-white font-medium">{status.window}</span></span>
            <span>Tracked IPs: <span className="text-white font-medium">{status.entries.length}</span></span>
          </div>
        </div>
      )}

      {/* Entries table */}
      {!status || status.entries.length === 0 ? (
        <div className="bg-dark-900 border border-dark-700 rounded-lg p-12 text-center">
          <ShieldAlert className="w-10 h-10 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-500">No rate-limited IPs</p>
          <p className="text-xs text-gray-600 mt-1">IPs appear here when they make login/registration requests</p>
        </div>
      ) : (
        <div className="bg-dark-900 border border-dark-700 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-dark-700 text-xs text-gray-500 uppercase tracking-wide">
                <th className="text-left px-4 py-3">IP Address</th>
                <th className="text-center px-4 py-3">Requests</th>
                <th className="text-center px-4 py-3">Status</th>
                <th className="text-center px-4 py-3">Resets In</th>
                <th className="text-right px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {status.entries.map((entry) => {
                const isBlocked = entry.count >= (status?.limit ?? 5)
                return (
                  <tr key={entry.ip} className="border-b border-dark-700/50 last:border-0">
                    <td className="px-4 py-3">
                      <span className="text-sm text-white font-mono">{entry.ip}</span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-sm font-medium ${isBlocked ? 'text-red-400' : 'text-gray-300'}`}>
                        {entry.count} / {status?.limit}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {isBlocked ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-500/10 text-red-400 rounded-full text-xs font-medium">
                          <XCircle className="w-3 h-3" />
                          Blocked
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-yellow-500/10 text-yellow-400 rounded-full text-xs font-medium">
                          Tracked
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="text-xs text-gray-500 tabular-nums">{formatTimeLeft(entry.reset_at)}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleClearIP(entry.ip)}
                        className="text-gray-500 hover:text-red-400 transition-colors"
                        title={`Clear rate limit for ${entry.ip}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Docker CLI info */}
      <div className="mt-6 bg-dark-900/50 border border-dark-700/50 rounded-lg p-4">
        <p className="text-xs text-gray-600">
          Rate limits can also be managed via Docker CLI for emergency access:
        </p>
        <code className="block mt-2 text-xs text-gray-500 font-mono bg-dark-950 rounded px-3 py-2">
          docker exec ftml-backend-1 curl -X DELETE http://localhost:8080/internal/ratelimit
        </code>
      </div>
    </div>
  )
}
