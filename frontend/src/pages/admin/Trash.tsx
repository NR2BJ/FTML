import { useState, useEffect } from 'react'
import { Trash2, RotateCcw, X, Loader2, Folder, FileVideo } from 'lucide-react'
import { listTrash, restoreTrash, permanentDeleteTrash, emptyTrash, type TrashEntry } from '@/api/files'
import { formatBytes } from '@/utils/format'

function formatTimeAgo(dateStr: string): string {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

export default function TrashPage() {
  const [items, setItems] = useState<TrashEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const fetchTrash = async () => {
    try {
      const { data } = await listTrash()
      setItems(data || [])
      setError('')
    } catch {
      setError('Failed to load trash')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchTrash()
  }, [])

  const handleRestore = async (name: string) => {
    setActionLoading(name)
    try {
      await restoreTrash(name)
      fetchTrash()
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to restore')
    } finally {
      setActionLoading(null)
    }
  }

  const handlePermanentDelete = async (name: string) => {
    if (!confirm('Permanently delete this item? This cannot be undone.')) return
    setActionLoading(name)
    try {
      await permanentDeleteTrash(name)
      fetchTrash()
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to delete')
    } finally {
      setActionLoading(null)
    }
  }

  const handleEmptyTrash = async () => {
    if (!confirm('Permanently delete ALL items in trash? This cannot be undone.')) return
    setActionLoading('empty')
    try {
      await emptyTrash()
      fetchTrash()
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to empty trash')
    } finally {
      setActionLoading(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Trash2 className="w-6 h-6 text-primary-500" />
          <h1 className="text-xl font-bold text-white">Trash</h1>
          <span className="text-sm text-gray-500">({items.length} items)</span>
        </div>
        {items.length > 0 && (
          <button
            onClick={handleEmptyTrash}
            disabled={actionLoading === 'empty'}
            className="text-sm text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
          >
            {actionLoading === 'empty' ? 'Emptying...' : 'Empty Trash'}
          </button>
        )}
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2 rounded-lg text-sm mb-4">
          {error}
        </div>
      )}

      {items.length === 0 ? (
        <div className="text-center py-16">
          <Trash2 className="w-12 h-12 text-gray-700 mx-auto mb-3" />
          <p className="text-gray-400">Trash is empty</p>
        </div>
      ) : (
        <div className="bg-dark-900 border border-dark-700 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-dark-700">
                <th className="text-left text-xs text-gray-400 font-medium px-4 py-3">Original Path</th>
                <th className="text-left text-xs text-gray-400 font-medium px-4 py-3 hidden sm:table-cell">Deleted By</th>
                <th className="text-left text-xs text-gray-400 font-medium px-4 py-3 hidden sm:table-cell">Deleted</th>
                <th className="text-left text-xs text-gray-400 font-medium px-4 py-3 hidden md:table-cell">Size</th>
                <th className="text-right text-xs text-gray-400 font-medium px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.name} className="border-b border-dark-800 hover:bg-dark-800/50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {item.is_dir ? (
                        <Folder className="w-4 h-4 text-yellow-400 shrink-0" />
                      ) : (
                        <FileVideo className="w-4 h-4 text-blue-400 shrink-0" />
                      )}
                      <span className="text-sm text-white truncate" title={item.original_path}>
                        {item.original_path || item.name}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-400 hidden sm:table-cell">
                    {item.deleted_by || '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-400 hidden sm:table-cell">
                    {item.deleted_at ? formatTimeAgo(item.deleted_at) : '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-400 hidden md:table-cell">
                    {item.size > 0 ? formatBytes(item.size) : '-'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleRestore(item.name)}
                        disabled={actionLoading === item.name}
                        className="text-blue-400 hover:text-blue-300 p-1 transition-colors disabled:opacity-50"
                        title="Restore"
                      >
                        {actionLoading === item.name ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <RotateCcw className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={() => handlePermanentDelete(item.name)}
                        disabled={actionLoading === item.name}
                        className="text-gray-500 hover:text-red-400 p-1 transition-colors disabled:opacity-50"
                        title="Permanently delete"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
