import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { Film, Search, LogOut, User, Settings, Clock, UserCog, Users, UserPlus, Shield, ChevronDown, Monitor, BarChart3, ShieldAlert } from 'lucide-react'
import { searchFiles, type FileEntry } from '@/api/files'
import { getPendingRegistrationCount } from '@/api/admin'

export default function Header() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FileEntry[]>([])
  const [showResults, setShowResults] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const userMenuRef = useRef<HTMLDivElement>(null)

  const isAdmin = user?.role === 'admin'

  // Fetch pending registration count for admin
  useEffect(() => {
    if (!isAdmin) return
    const fetchCount = async () => {
      try {
        const { data } = await getPendingRegistrationCount()
        setPendingCount(data.count)
      } catch {
        // ignore
      }
    }
    fetchCount()
    const interval = setInterval(fetchCount, 60000) // refresh every minute
    return () => clearInterval(interval)
  }, [isAdmin])

  // Close user menu on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Close user menu on route change
  useEffect(() => {
    setShowUserMenu(false)
  }, [location])

  const handleSearch = async (value: string) => {
    setQuery(value)
    if (value.length < 2) {
      setResults([])
      setShowResults(false)
      return
    }
    try {
      const { data } = await searchFiles(value)
      setResults(data.results || [])
      setShowResults(true)
    } catch {
      setResults([])
    }
  }

  const handleSelect = (entry: FileEntry) => {
    setShowResults(false)
    setQuery('')
    if (entry.is_dir) {
      navigate(`/browse/${entry.path}`)
    } else {
      navigate(`/watch/${entry.path}`)
    }
  }

  return (
    <header className="bg-dark-900 border-b border-dark-700 px-4 py-3 flex items-center gap-4">
      <div
        className="flex items-center gap-2 cursor-pointer"
        onClick={() => navigate('/')}
      >
        <Film className="w-6 h-6 text-primary-500" />
        <span className="font-bold text-lg text-white hidden sm:block">Video Stream</span>
      </div>

      <div className="flex-1 max-w-md mx-auto relative">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            onBlur={() => setTimeout(() => setShowResults(false), 200)}
            placeholder="Search files..."
            className="w-full bg-dark-800 border border-dark-700 rounded-lg pl-10 pr-4 py-2 text-sm text-white focus:outline-none focus:border-primary-500 transition-colors"
          />
        </div>

        {showResults && results.length > 0 && (
          <div className="absolute top-full mt-1 w-full bg-dark-800 border border-dark-700 rounded-lg shadow-xl z-50 max-h-64 overflow-auto">
            {results.map((r) => (
              <button
                key={r.path}
                onClick={() => handleSelect(r)}
                className="w-full text-left px-4 py-2 hover:bg-dark-700 text-sm text-gray-300 truncate"
              >
                {r.is_dir ? '📁' : '🎬'} {r.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* History */}
        <button
          onClick={() => navigate('/history')}
          className="text-gray-400 hover:text-white transition-colors"
          title="Watch History"
        >
          <Clock className="w-5 h-5" />
        </button>

        {/* Admin: Settings */}
        {isAdmin && (
          <button
            onClick={() => navigate('/settings')}
            className="text-gray-400 hover:text-white transition-colors"
            title="Settings"
          >
            <Settings className="w-5 h-5" />
          </button>
        )}

        {/* User menu dropdown */}
        <div className="relative" ref={userMenuRef}>
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex items-center gap-1.5 text-gray-400 hover:text-white transition-colors"
          >
            <User className="w-4 h-4" />
            <span className="text-sm hidden sm:block">{user?.username}</span>
            {isAdmin && pendingCount > 0 && (
              <span className="bg-red-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                {pendingCount}
              </span>
            )}
            <ChevronDown className="w-3 h-3" />
          </button>

          {showUserMenu && (
            <div className="absolute right-0 top-full mt-2 w-48 bg-dark-800 border border-dark-700 rounded-lg shadow-xl z-50 py-1">
              {/* Role badge */}
              <div className="px-3 py-2 border-b border-dark-700">
                <div className="flex items-center gap-2">
                  <Shield className="w-3 h-3 text-gray-500" />
                  <span className="text-xs text-gray-400 capitalize">{user?.role}</span>
                </div>
              </div>

              {/* Admin links */}
              {isAdmin && (
                <>
                  <button
                    onClick={() => navigate('/admin/users')}
                    className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-dark-700 flex items-center gap-2"
                  >
                    <Users className="w-4 h-4" />
                    Users
                  </button>
                  <button
                    onClick={() => navigate('/admin/registrations')}
                    className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-dark-700 flex items-center gap-2"
                  >
                    <UserPlus className="w-4 h-4" />
                    Registrations
                    {pendingCount > 0 && (
                      <span className="bg-red-500/20 text-red-400 text-[10px] font-bold px-1.5 py-0.5 rounded-full ml-auto">
                        {pendingCount}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={() => navigate('/admin/sessions')}
                    className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-dark-700 flex items-center gap-2"
                  >
                    <Monitor className="w-4 h-4" />
                    Sessions
                  </button>
                  <button
                    onClick={() => navigate('/admin/dashboard')}
                    className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-dark-700 flex items-center gap-2"
                  >
                    <BarChart3 className="w-4 h-4" />
                    Dashboard
                  </button>
                  <button
                    onClick={() => navigate('/admin/ratelimits')}
                    className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-dark-700 flex items-center gap-2"
                  >
                    <ShieldAlert className="w-4 h-4" />
                    Rate Limits
                  </button>
                  <div className="border-b border-dark-700 my-1" />
                </>
              )}

              {/* Common links */}
              <button
                onClick={() => navigate('/account')}
                className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-dark-700 flex items-center gap-2"
              >
                <UserCog className="w-4 h-4" />
                Account
              </button>
              <button
                onClick={logout}
                className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-dark-700 flex items-center gap-2"
              >
                <LogOut className="w-4 h-4" />
                Logout
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
