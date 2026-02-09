import { useState, useEffect } from 'react'
import { Users, Plus, Pencil, Trash2, X, Check, Eye, EyeOff } from 'lucide-react'
import {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  type AdminUser,
  type CreateUserRequest,
} from '@/api/admin'

const roleBadge = (role: string) => {
  const colors: Record<string, string> = {
    admin: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    user: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  }
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${colors[role] || colors.user}`}>
      {role}
    </span>
  )
}

export default function UserManagement() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Add form
  const [showAdd, setShowAdd] = useState(false)
  const [newUser, setNewUser] = useState<CreateUserRequest>({ username: '', password: '', role: 'user' })
  const [showNewUserPw, setShowNewUserPw] = useState(false)
  const [showEditPw, setShowEditPw] = useState(false)
  const [addError, setAddError] = useState('')

  // Edit state
  const [editId, setEditId] = useState<number | null>(null)
  const [editData, setEditData] = useState({ username: '', role: '', password: '' })
  const [editError, setEditError] = useState('')

  const fetchUsers = async () => {
    try {
      const { data } = await listUsers()
      setUsers(data)
      setError('')
    } catch {
      setError('Failed to load users')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchUsers()
  }, [])

  const handleCreate = async () => {
    if (!newUser.username || !newUser.password) {
      setAddError('Username and password are required')
      return
    }
    try {
      await createUser(newUser)
      setNewUser({ username: '', password: '', role: 'user' })
      setShowAdd(false)
      setAddError('')
      fetchUsers()
    } catch (err: any) {
      setAddError(err.response?.data?.error || 'Failed to create user')
    }
  }

  const handleUpdate = async (id: number) => {
    try {
      const data: any = {}
      if (editData.username) data.username = editData.username
      if (editData.role) data.role = editData.role
      if (editData.password) data.password = editData.password
      await updateUser(id, data)
      setEditId(null)
      setEditError('')
      fetchUsers()
    } catch (err: any) {
      setEditError(err.response?.data?.error || 'Failed to update user')
    }
  }

  const handleDelete = async (id: number, username: string) => {
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return
    try {
      await deleteUser(id)
      fetchUsers()
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to delete user')
    }
  }

  const startEdit = (user: AdminUser) => {
    setEditId(user.id)
    setEditData({ username: user.username, role: user.role, password: '' })
    setEditError('')
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
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Users className="w-6 h-6 text-primary-500" />
          <h1 className="text-xl font-bold text-white">User Management</h1>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 rounded-lg text-sm transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add User
        </button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2 rounded-lg text-sm mb-4">
          {error}
        </div>
      )}

      {/* Add User Form */}
      {showAdd && (
        <div className="bg-dark-800 border border-dark-700 rounded-lg p-4 mb-4">
          <h3 className="text-sm font-medium text-white mb-3">New User</h3>
          {addError && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-3 py-1.5 rounded text-sm mb-3">
              {addError}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              type="text"
              value={newUser.username}
              onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
              placeholder="Username"
              className="bg-dark-900 border border-dark-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary-500"
            />
            <div className="relative">
              <input
                type={showNewUserPw ? 'text' : 'password'}
                value={newUser.password}
                onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                placeholder="Password"
                className="w-full bg-dark-900 border border-dark-600 rounded-lg px-3 py-2 pr-10 text-sm text-white focus:outline-none focus:border-primary-500"
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowNewUserPw(!showNewUserPw)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
              >
                {showNewUserPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <div className="flex gap-2">
              <select
                value={newUser.role}
                onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                className="flex-1 bg-dark-900 border border-dark-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary-500"
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
              <button
                onClick={handleCreate}
                className="bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 rounded-lg text-sm transition-colors"
              >
                Create
              </button>
              <button
                onClick={() => { setShowAdd(false); setAddError('') }}
                className="text-gray-400 hover:text-white px-2 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Users Table */}
      <div className="bg-dark-900 border border-dark-700 rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-dark-700">
              <th className="text-left text-xs text-gray-400 font-medium px-4 py-3">Username</th>
              <th className="text-left text-xs text-gray-400 font-medium px-4 py-3">Role</th>
              <th className="text-left text-xs text-gray-400 font-medium px-4 py-3 hidden sm:table-cell">Created</th>
              <th className="text-right text-xs text-gray-400 font-medium px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-b border-dark-800 hover:bg-dark-800/50">
                {editId === user.id ? (
                  <>
                    <td className="px-4 py-3">
                      <input
                        type="text"
                        value={editData.username}
                        onChange={(e) => setEditData({ ...editData, username: e.target.value })}
                        className="bg-dark-800 border border-dark-600 rounded px-2 py-1 text-sm text-white w-full focus:outline-none focus:border-primary-500"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={editData.role}
                        onChange={(e) => setEditData({ ...editData, role: e.target.value })}
                        className="bg-dark-800 border border-dark-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-primary-500"
                      >
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell">
                      <div className="relative">
                        <input
                          type={showEditPw ? 'text' : 'password'}
                          value={editData.password}
                          onChange={(e) => setEditData({ ...editData, password: e.target.value })}
                          placeholder="New password (optional)"
                          className="bg-dark-800 border border-dark-600 rounded px-2 py-1 pr-8 text-sm text-white w-full focus:outline-none focus:border-primary-500"
                        />
                        <button
                          type="button"
                          tabIndex={-1}
                          onClick={() => setShowEditPw(!showEditPw)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                        >
                          {showEditPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {editError && (
                          <span className="text-red-400 text-xs mr-2">{editError}</span>
                        )}
                        <button
                          onClick={() => handleUpdate(user.id)}
                          className="text-green-400 hover:text-green-300 p-1 transition-colors"
                          title="Save"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => { setEditId(null); setEditError('') }}
                          className="text-gray-400 hover:text-white p-1 transition-colors"
                          title="Cancel"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-4 py-3 text-sm text-white">{user.username}</td>
                    <td className="px-4 py-3">{roleBadge(user.role)}</td>
                    <td className="px-4 py-3 text-sm text-gray-400 hidden sm:table-cell">
                      {new Date(user.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => startEdit(user)}
                          className="text-gray-400 hover:text-white p-1 transition-colors"
                          title="Edit"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(user.id, user.username)}
                          className="text-gray-400 hover:text-red-400 p-1 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && (
          <div className="text-center text-gray-400 py-8 text-sm">No users found</div>
        )}
      </div>
    </div>
  )
}
