import { useState, useEffect } from 'react'
import { getDashboardStats, type DashboardStats } from '@/api/admin'
import { Cpu, HardDrive, MemoryStick, Users, Monitor, Clock, Loader2, RefreshCw } from 'lucide-react'
import { formatBytes } from '@/utils/format'

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function ProgressBar({ value, max, color = 'bg-primary-500' }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="h-2 bg-dark-700 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

function StatCard({ icon: Icon, label, value, sub }: {
  icon: React.ElementType
  label: string
  value: string | number
  sub?: string
}) {
  return (
    <div className="bg-dark-900 border border-dark-700 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4 text-gray-500" />
        <span className="text-xs text-gray-500 uppercase tracking-wide">{label}</span>
      </div>
      <p className="text-xl font-semibold text-white">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
}

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadStats = async () => {
    try {
      const { data } = await getDashboardStats()
      setStats(data)
      setError(null)
    } catch {
      setError('Failed to load dashboard')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadStats()
    const interval = setInterval(loadStats, 15000) // refresh every 15s
    return () => clearInterval(interval)
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
      </div>
    )
  }

  if (error || !stats) {
    return (
      <div className="text-center text-red-400 mt-16">{error}</div>
    )
  }

  const vramUsed = stats.gpu.vram_total - stats.gpu.vram_free
  const vramPct = stats.gpu.vram_total > 0 ? (vramUsed / stats.gpu.vram_total) * 100 : 0
  const storagePct = stats.storage.total > 0 ? (stats.storage.used / stats.storage.total) * 100 : 0

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Monitor className="w-6 h-6 text-gray-400" />
          <h1 className="text-xl font-semibold text-white">System Dashboard</h1>
        </div>
        <button
          onClick={loadStats}
          className="text-gray-400 hover:text-white transition-colors"
          title="Refresh"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard icon={Monitor} label="Active Sessions" value={stats.active_sessions} />
        <StatCard icon={Users} label="Users" value={stats.user_count} />
        <StatCard icon={Clock} label="Uptime" value={formatUptime(stats.system.uptime_seconds)} />
        <StatCard
          icon={Cpu}
          label="Goroutines"
          value={stats.system.goroutines}
          sub={stats.system.go_version}
        />
      </div>

      {/* GPU */}
      <div className="bg-dark-900 border border-dark-700 rounded-lg p-5 mb-4">
        <div className="flex items-center gap-2 mb-4">
          <Cpu className="w-5 h-5 text-blue-400" />
          <h2 className="text-sm font-medium text-white">GPU</h2>
        </div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-gray-300">{stats.gpu.device || 'No GPU detected'}</span>
          <span className="text-xs text-gray-500">Driver: {stats.gpu.driver || 'N/A'}</span>
        </div>
        {stats.gpu.vram_total > 0 && (
          <>
            <ProgressBar
              value={vramUsed}
              max={stats.gpu.vram_total}
              color={vramPct > 90 ? 'bg-red-500' : vramPct > 70 ? 'bg-yellow-500' : 'bg-blue-500'}
            />
            <div className="flex justify-between mt-1.5">
              <span className="text-xs text-gray-500">
                VRAM: {formatBytes(vramUsed)} / {formatBytes(stats.gpu.vram_total)}
              </span>
              <span className="text-xs text-gray-500">{vramPct.toFixed(1)}%</span>
            </div>
          </>
        )}
      </div>

      {/* Storage */}
      <div className="bg-dark-900 border border-dark-700 rounded-lg p-5 mb-4">
        <div className="flex items-center gap-2 mb-4">
          <HardDrive className="w-5 h-5 text-green-400" />
          <h2 className="text-sm font-medium text-white">Storage</h2>
        </div>
        {stats.storage.total > 0 ? (
          <>
            <ProgressBar
              value={stats.storage.used}
              max={stats.storage.total}
              color={storagePct > 90 ? 'bg-red-500' : storagePct > 70 ? 'bg-yellow-500' : 'bg-green-500'}
            />
            <div className="flex justify-between mt-1.5">
              <span className="text-xs text-gray-500">
                Used: {formatBytes(stats.storage.used)} / {formatBytes(stats.storage.total)}
              </span>
              <span className="text-xs text-gray-500">
                Free: {formatBytes(stats.storage.free)} ({(100 - storagePct).toFixed(1)}%)
              </span>
            </div>
          </>
        ) : (
          <p className="text-sm text-gray-500">Storage info unavailable</p>
        )}
      </div>

      {/* Memory */}
      <div className="bg-dark-900 border border-dark-700 rounded-lg p-5">
        <div className="flex items-center gap-2 mb-4">
          <MemoryStick className="w-5 h-5 text-purple-400" />
          <h2 className="text-sm font-medium text-white">Process Memory</h2>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <span className="text-xs text-gray-500">Heap Allocated</span>
            <p className="text-lg font-medium text-white">{formatBytes(stats.system.mem_alloc)}</p>
          </div>
          <div>
            <span className="text-xs text-gray-500">System Memory</span>
            <p className="text-lg font-medium text-white">{formatBytes(stats.system.mem_sys)}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
