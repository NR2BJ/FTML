import { useState, useEffect, useCallback } from 'react'
import { getDashboardStats, listFileLogs, type DashboardStats, type FileLog } from '@/api/admin'
import { Cpu, HardDrive, MemoryStick, Users, Monitor, Clock, Loader2, RefreshCw, FileText } from 'lucide-react'
import { formatBytes, formatDateTime } from '@/utils/format'

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

const actionLabels: Record<string, { label: string; color: string }> = {
  upload: { label: 'Upload', color: 'text-green-400' },
  delete: { label: 'Delete', color: 'text-red-400' },
  move: { label: 'Move', color: 'text-blue-400' },
  mkdir: { label: 'New Folder', color: 'text-yellow-400' },
  restore: { label: 'Restore', color: 'text-emerald-400' },
  permanent_delete: { label: 'Perm. Delete', color: 'text-red-500' },
  empty_trash: { label: 'Empty Trash', color: 'text-red-500' },
  subtitle_generate: { label: 'STT Generate', color: 'text-cyan-400' },
  subtitle_translate: { label: 'Sub Translate', color: 'text-emerald-400' },
  subtitle_delete: { label: 'Sub Delete', color: 'text-red-400' },
  subtitle_upload: { label: 'Sub Upload', color: 'text-teal-400' },
  subtitle_convert: { label: 'Sub Convert', color: 'text-indigo-400' },
  subtitle_delete_request: { label: 'Del. Request', color: 'text-orange-400' },
}

const logFilterTabs = [
  { label: 'All', value: '' },
  { label: 'Upload', value: 'upload' },
  { label: 'Move', value: 'move' },
  { label: 'Delete', value: 'delete' },
  { label: 'Subtitle', value: 'subtitle' },
]

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [logs, setLogs] = useState<FileLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [logFilter, setLogFilter] = useState('')

  const loadStats = useCallback(async () => {
    try {
      const [statsRes, logsRes] = await Promise.all([
        getDashboardStats(),
        listFileLogs(50, logFilter || undefined),
      ])
      setStats(statsRes.data)
      setLogs(logsRes.data || [])
      setError(null)
    } catch {
      setError('Failed to load dashboard')
    } finally {
      setLoading(false)
    }
  }, [logFilter])

  useEffect(() => {
    loadStats()
    const STATS_REFRESH_INTERVAL_MS = 15000
    const interval = setInterval(loadStats, STATS_REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [loadStats])

  const handleFilterChange = (value: string) => {
    setLogFilter(value)
  }

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

  const tz = stats.timezone || undefined
  const vramAvailable = stats.gpu.vram_free >= 0
  const vramUsed = vramAvailable ? stats.gpu.vram_total - stats.gpu.vram_free : 0
  const vramPct = vramAvailable && stats.gpu.vram_total > 0 ? (vramUsed / stats.gpu.vram_total) * 100 : 0
  const storagePct = stats.storage.total > 0 ? (stats.storage.used / stats.storage.total) * 100 : 0
  const memUsed = stats.system.total_memory - stats.system.avail_memory
  const memPct = stats.system.total_memory > 0 ? (memUsed / stats.system.total_memory) * 100 : 0

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
          label="CPU"
          value={`${stats.system.cpu_cores} Cores`}
          sub={stats.system.cpu_model || stats.system.go_version}
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
        {stats.gpu.vram_total > 0 && vramAvailable ? (
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
        ) : stats.gpu.vram_total > 0 ? (
          <div className="mt-1">
            <p className="text-xs text-gray-500">
              VRAM: {formatBytes(stats.gpu.vram_total)} total
            </p>
            <p className="text-xs text-gray-600 mt-0.5">
              Usage monitoring unavailable (no sysfs interface)
            </p>
          </div>
        ) : stats.gpu.device ? (
          <p className="text-xs text-gray-500">VRAM info unavailable</p>
        ) : null}
      </div>

      {/* Memory */}
      <div className="bg-dark-900 border border-dark-700 rounded-lg p-5 mb-4">
        <div className="flex items-center gap-2 mb-4">
          <MemoryStick className="w-5 h-5 text-purple-400" />
          <h2 className="text-sm font-medium text-white">Memory</h2>
        </div>
        {stats.system.total_memory > 0 ? (
          <>
            <ProgressBar
              value={memUsed}
              max={stats.system.total_memory}
              color={memPct > 90 ? 'bg-red-500' : memPct > 70 ? 'bg-yellow-500' : 'bg-purple-500'}
            />
            <div className="flex justify-between mt-1.5">
              <span className="text-xs text-gray-500">
                System RAM: {formatBytes(memUsed)} / {formatBytes(stats.system.total_memory)}
              </span>
              <span className="text-xs text-gray-500">{memPct.toFixed(1)}%</span>
            </div>
            <div className="mt-2 text-xs text-gray-600">
              App Heap: {formatBytes(stats.system.mem_alloc)} · App Reserved: {formatBytes(stats.system.mem_sys)}
              <span className="ml-1 text-gray-700" title="Go runtime memory — the application's own heap and reserved memory, not total process RSS">(Go runtime)</span>
            </div>
          </>
        ) : (
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

      {/* File Activity Logs */}
      <div className="bg-dark-900 border border-dark-700 rounded-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-amber-400" />
            <h2 className="text-sm font-medium text-white">File Activity</h2>
          </div>
          <div className="flex items-center gap-1 bg-dark-800 border border-dark-700 rounded-lg p-0.5">
            {logFilterTabs.map((tab) => (
              <button
                key={tab.value}
                onClick={() => handleFilterChange(tab.value)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  logFilter === tab.value
                    ? 'bg-primary-600 text-white'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        {logs.length === 0 ? (
          <p className="text-sm text-gray-500">No file activity yet</p>
        ) : (
          <div className="space-y-1.5 max-h-80 overflow-y-auto">
            {logs.map((log) => {
              const actionInfo = actionLabels[log.action] || { label: log.action, color: 'text-gray-400' }
              return (
                <div key={log.id} className="flex items-center gap-3 text-sm py-1.5 px-2 rounded hover:bg-dark-800/50">
                  <span className={`text-xs font-medium w-20 shrink-0 ${actionInfo.color}`}>
                    {actionInfo.label}
                  </span>
                  <span className="text-gray-300 truncate flex-1" title={log.file_path}>
                    {log.file_path}
                  </span>
                  {log.detail && (
                    <span className="text-xs text-gray-600 shrink-0">{log.detail}</span>
                  )}
                  <span className="text-xs text-gray-600 shrink-0 w-16 text-right">
                    {log.username}
                  </span>
                  <span className="text-xs text-gray-600 shrink-0 w-28 text-right">
                    {formatDateTime(log.created_at, tz)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
