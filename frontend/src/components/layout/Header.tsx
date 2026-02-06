import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { Film, Search, LogOut, User } from 'lucide-react'
import { searchFiles, type FileEntry } from '@/api/files'

export default function Header() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FileEntry[]>([])
  const [showResults, setShowResults] = useState(false)

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

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <User className="w-4 h-4" />
          <span className="hidden sm:block">{user?.username}</span>
        </div>
        <button
          onClick={logout}
          className="text-gray-400 hover:text-white transition-colors"
          title="Logout"
        >
          <LogOut className="w-5 h-5" />
        </button>
      </div>
    </header>
  )
}
