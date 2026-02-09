import { useState, useEffect } from 'react'
import { UserPlus, Check, X, Trash2, Loader2 } from 'lucide-react'
import {
  listRegistrations,
  approveRegistration,
  rejectRegistration,
  deleteRegistration,
  type Registration,
} from '@/api/admin'

export default function Registrations() {
  const [registrations, setRegistrations] = useState<Registration[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<'pending' | 'approved' | 'rejected'>('pending')

  const fetchRegistrations = async () => {
    try {
      const { data } = await listRegistrations(filter)
      setRegistrations(data)
      setError('')
    } catch {
      setError('Failed to load registrations')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setLoading(true)
    fetchRegistrations()
  }, [filter])

  const notifyBadge = () => {
    window.dispatchEvent(new Event('registration-updated'))
  }

  const handleApprove = async (id: number) => {
    try {
      await approveRegistration(id)
      fetchRegistrations()
      notifyBadge()
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to approve registration')
    }
  }

  const handleReject = async (id: number) => {
    if (!confirm('Reject this registration request?')) return
    try {
      await rejectRegistration(id)
      fetchRegistrations()
      notifyBadge()
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to reject registration')
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this registration record?')) return
    try {
      await deleteRegistration(id)
      fetchRegistrations()
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to delete registration')
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
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <UserPlus className="w-6 h-6 text-primary-500" />
          <h1 className="text-xl font-bold text-white">Registration Requests</h1>
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
              <th className="text-left text-xs text-gray-400 font-medium px-4 py-3">Username</th>
              <th className="text-left text-xs text-gray-400 font-medium px-4 py-3">Status</th>
              <th className="text-left text-xs text-gray-400 font-medium px-4 py-3 hidden sm:table-cell">Requested</th>
              <th className="text-right text-xs text-gray-400 font-medium px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {registrations.map((reg) => (
              <tr key={reg.id} className="border-b border-dark-800 hover:bg-dark-800/50">
                <td className="px-4 py-3 text-sm text-white">{reg.username}</td>
                <td className="px-4 py-3">{statusBadge(reg.status)}</td>
                <td className="px-4 py-3 text-sm text-gray-400 hidden sm:table-cell">
                  {new Date(reg.created_at).toLocaleDateString()}{' '}
                  {new Date(reg.created_at).toLocaleTimeString()}
                </td>
                <td className="px-4 py-3 text-right">
                  {reg.status === 'pending' ? (
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleApprove(reg.id)}
                        className="text-green-400 hover:text-green-300 p-1 transition-colors"
                        title="Approve"
                      >
                        <Check className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleReject(reg.id)}
                        className="text-red-400 hover:text-red-300 p-1 transition-colors"
                        title="Reject"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => handleDelete(reg.id)}
                      className="text-gray-500 hover:text-red-400 p-1 transition-colors"
                      title="Delete record"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {registrations.length === 0 && (
          <div className="text-center text-gray-400 py-8 text-sm">
            No {filter} registrations
          </div>
        )}
      </div>
    </div>
  )
}
