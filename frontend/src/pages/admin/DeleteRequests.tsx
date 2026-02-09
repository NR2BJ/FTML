import { useState, useEffect } from 'react'
import { Trash2, Check, X, Loader2, FileX } from 'lucide-react'
import {
  listDeleteRequests,
  approveDeleteRequest,
  rejectDeleteRequest,
  removeDeleteRequest,
  type DeleteRequestAdmin,
} from '@/api/admin'

export default function DeleteRequests() {
  const [requests, setRequests] = useState<DeleteRequestAdmin[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<'pending' | 'approved' | 'rejected'>('pending')

  const fetchRequests = async () => {
    try {
      const { data } = await listDeleteRequests(filter)
      setRequests(data)
      setError('')
    } catch {
      setError('Failed to load delete requests')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setLoading(true)
    fetchRequests()
  }, [filter])

  const notifyBadge = () => {
    window.dispatchEvent(new Event('delete-request-updated'))
  }

  const handleApprove = async (id: number) => {
    try {
      await approveDeleteRequest(id)
      fetchRequests()
      notifyBadge()
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to approve request')
    }
  }

  const handleReject = async (id: number) => {
    if (!confirm('Reject this delete request?')) return
    try {
      await rejectDeleteRequest(id)
      fetchRequests()
      notifyBadge()
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to reject request')
    }
  }

  const handleRemove = async (id: number) => {
    if (!confirm('Remove this record?')) return
    try {
      await removeDeleteRequest(id)
      fetchRequests()
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to remove record')
    }
  }

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      pending: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
      approved: 'bg-green-500/20 text-green-400 border-green-500/30',
      rejected: 'bg-red-500/20 text-red-400 border-red-500/30',
    }
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${colors[status] || ''}`}>
        {status}
      </span>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <FileX className="w-6 h-6 text-orange-500" />
          <h1 className="text-xl font-bold text-white">Delete Requests</h1>
        </div>

        <div className="flex items-center gap-1 bg-dark-800 border border-dark-700 rounded-lg p-1">
          {(['pending', 'approved', 'rejected'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors capitalize ${
                filter === f
                  ? 'bg-primary-600 text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2 rounded-lg text-sm mb-4">
          {error}
        </div>
      )}

      <div className="bg-dark-900 border border-dark-700 rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-dark-700">
              <th className="text-left text-xs text-gray-400 font-medium px-4 py-3">User</th>
              <th className="text-left text-xs text-gray-400 font-medium px-4 py-3 hidden lg:table-cell">Video</th>
              <th className="text-left text-xs text-gray-400 font-medium px-4 py-3">Subtitle</th>
              <th className="text-left text-xs text-gray-400 font-medium px-4 py-3 hidden md:table-cell">Reason</th>
              <th className="text-left text-xs text-gray-400 font-medium px-4 py-3">Status</th>
              <th className="text-left text-xs text-gray-400 font-medium px-4 py-3 hidden sm:table-cell">Date</th>
              <th className="text-right text-xs text-gray-400 font-medium px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((req) => (
              <tr key={req.id} className="border-b border-dark-800 hover:bg-dark-800/50">
                <td className="px-4 py-3 text-sm text-white">{req.username}</td>
                <td className="px-4 py-3 text-sm text-gray-400 max-w-[200px] truncate hidden lg:table-cell" title={req.video_path}>
                  {req.video_path.split('/').pop()}
                </td>
                <td className="px-4 py-3 text-sm text-gray-300 max-w-[150px] truncate" title={req.subtitle_label}>
                  {req.subtitle_label || req.subtitle_id}
                </td>
                <td className="px-4 py-3 text-sm text-gray-400 max-w-[150px] truncate hidden md:table-cell" title={req.reason}>
                  {req.reason || '-'}
                </td>
                <td className="px-4 py-3">{statusBadge(req.status)}</td>
                <td className="px-4 py-3 text-sm text-gray-400 hidden sm:table-cell">
                  {new Date(req.created_at).toLocaleDateString()}{' '}
                  {new Date(req.created_at).toLocaleTimeString()}
                </td>
                <td className="px-4 py-3 text-right">
                  {req.status === 'pending' ? (
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleApprove(req.id)}
                        className="text-green-400 hover:text-green-300 p-1 transition-colors"
                        title="Approve (delete subtitle)"
                      >
                        <Check className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleReject(req.id)}
                        className="text-red-400 hover:text-red-300 p-1 transition-colors"
                        title="Reject"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => handleRemove(req.id)}
                      className="text-gray-500 hover:text-red-400 p-1 transition-colors"
                      title="Remove record"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {requests.length === 0 && (
          <div className="text-center text-gray-400 py-8 text-sm">
            No {filter} delete requests
          </div>
        )}
      </div>
    </div>
  )
}
