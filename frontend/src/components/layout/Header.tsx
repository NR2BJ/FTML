import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useThemeStore } from '@/stores/themeStore'
import {
  Film, Search, LogOut, User, Settings, Clock, UserCog, Users, UserPlus,
  Shield, ChevronDown, Monitor, BarChart3, ShieldAlert, Menu,
  Folder, FileVideo, Trash2, Sun, Moon, Laptop, FileX, Briefcase
} from 'lucide-react'
import { searchFiles, type FileEntry } from '@/api/files'
import { getPendingRegistrationCount, getPendingDeleteRequestCount } from '@/api/admin'
import JobIndicator from './JobIndicator'

export default function Header() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar)
  const { theme, setTheme } = useThemeStore()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FileEntry[]>([])
  const [showResults, setShowResults] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [pendingRegCount, setPendingRegCount] = useState(0)
  const [pendingDelReqCount, setPendingDelReqCount] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const isAdmin = user?.role === 'admin'

  // Fetch pending counts for admin
  const fetchPendingCount = useCallback(async () => {
    if (!isAdmin) return
    try {
      const [regRes, delRes] = await Promise.all([
        getPendingRegistrationCount(),
        getPendingDeleteRequestCount(),
      ])
      setPendingRegCount(regRes.data.count)
      setPendingDelReqCount(delRes.data.count)
    } catch {
      // ignore
    }
  }, [isAdmin])

  useEffect(() => {
    fetchPendingCount()
    const PENDING_COUNT_INTERVAL_MS = 60000
    const interval = setInterval(fetchPendingCount, PENDING_COUNT_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [fetchPendingCount])

  // Listen for registration/delete-request updates (instant badge refresh)
  useEffect(() => {
    const handler = () => fetchPendingCount()
    window.addEventListener('registration-updated', handler)
    window.addEventListener('delete-request-updated', handler)
    return () => {
      window.removeEventListener('registration-updated', handler)
      window.removeEventListener('delete-request-updated', handler)
    }
  }, [fetchPendingCount])

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
    setSelectedIndex(-1)
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

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (!showResults || results.length === 0) {
      if (e.key === 'Escape') {
        setQuery('')
        setShowResults(false)
        searchInputRef.current?.blur()
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIndex((prev) => (prev + 1) % results.length)
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelectedIndex((prev) => (prev <= 0 ? results.length - 1 : prev - 1))
        break
      case 'Enter':
        e.preventDefault()
        if (selectedIndex >= 0 && selectedIndex < results.length) {
          handleSelect(results[selectedIndex])
        }
        break
      case 'Escape':
        setShowResults(false)
        setQuery('')
        searchInputRef.current?.blur()
        break
    }
  }

  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Laptop
  const nextTheme = (): 'light' | 'dark' | 'system' => {
    if (theme === 'dark') return 'light'
    if (theme === 'light') return 'system'
    return 'dark'
  }

  return (
    <header className="bg-dark-900 border-b border-dark-700 px-4 py-3 flex items-center gap-4">
      {/* Hamburger (mobile) */}
      <button
        onClick={toggleSidebar}
        className="text-gray-400 hover:text-white transition-colors md:hidden"
      >
        <Menu className="w-5 h-5" />
      </button>

      <div
        className="flex items-center gap-2 cursor-pointer"
        onClick={() => navigate('/')}
      >
        <Film className="w-6 h-6 text-primary-500" />
        <span className="font-bold text-lg text-white hidden sm:block">FTML</span>
      </div>

      <div className="flex-1 max-w-md mx-auto relative">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            onBlur={() => setTimeout(() => setShowResults(false), 200)}
            onFocus={() => { if (results.length > 0) setShowResults(true) }}
            placeholder="Search files..."
            className="w-full bg-dark-800 border border-dark-700 rounded-lg pl-10 pr-4 py-2 text-sm text-white focus:outline-none focus:border-primary-500 transition-colors"
          />
        </div>

        {showResults && results.length > 0 && (
          <div className="absolute top-full mt-1 w-full bg-dark-800 border border-dark-700 rounded-lg shadow-xl z-50 max-h-64 overflow-auto">
            {results.map((r, idx) => (
              <button
                key={r.path}
                onClick={() => handleSelect(r)}
                className={`w-full text-left px-4 py-2 hover:bg-dark-700 text-sm transition-colors flex items-center gap-2 ${
                  idx === selectedIndex ? 'bg-dark-700 text-white' : 'text-gray-300'
                }`}
              >
                {r.is_dir ? (
                  <Folder className="w-4 h-4 text-yellow-400 shrink-0" />
                ) : (
                  <FileVideo className="w-4 h-4 text-blue-400 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate">{r.name}</div>
                  <div className="text-xs text-gray-500 truncate">{r.path}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* Theme toggle */}
        <button
          onClick={() => setTheme(nextTheme())}
          className="text-gray-400 hover:text-white transition-colors"
          title={`Theme: ${theme}`}
        >
          <ThemeIcon className="w-5 h-5" />
        </button>

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

        {/* Job progress indicator */}
        <JobIndicator />

        {/* User menu dropdown */}
        <div className="relative" ref={userMenuRef}>
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex items-center gap-1.5 text-gray-400 hover:text-white transition-colors"
          >
            <User className="w-4 h-4" />
            <span className="text-sm hidden sm:block">{user?.username}</span>
            {isAdmin && (pendingRegCount + pendingDelReqCount) > 0 && (
              <span className="bg-red-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                {pendingRegCount + pendingDelReqCount}
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
                    {pendingRegCount > 0 && (
                      <span className="bg-red-500/20 text-red-400 text-[10px] font-bold px-1.5 py-0.5 rounded-full ml-auto">
                        {pendingRegCount}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={() => navigate('/admin/delete-requests')}
                    className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-dark-700 flex items-center gap-2"
                  >
                    <FileX className="w-4 h-4" />
                    Delete Requests
                    {pendingDelReqCount > 0 && (
                      <span className="bg-orange-500/20 text-orange-400 text-[10px] font-bold px-1.5 py-0.5 rounded-full ml-auto">
                        {pendingDelReqCount}
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
                    onClick={() => navigate('/admin/trash')}
                    className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-dark-700 flex items-center gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    Trash
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
                onClick={() => navigate('/jobs')}
                className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-dark-700 flex items-center gap-2"
              >
                <Briefcase className="w-4 h-4" />
                Jobs
              </button>
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
