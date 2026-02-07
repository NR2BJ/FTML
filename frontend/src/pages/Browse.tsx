import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getTree, getThumbnailUrl, type FileEntry } from '@/api/files'
import { Folder, FileVideo, File, ArrowLeft, Play, List, LayoutGrid, Grid3X3, Image } from 'lucide-react'
import { isVideoFile, formatBytes } from '@/utils/format'

type ViewMode = 'details' | 'grid' | 'small-icons' | 'large-icons'

const VIEW_MODES: { value: ViewMode; icon: typeof List; label: string }[] = [
  { value: 'details', icon: List, label: '자세히' },
  { value: 'small-icons', icon: Grid3X3, label: '작은 아이콘' },
  { value: 'grid', icon: LayoutGrid, label: '격자' },
  { value: 'large-icons', icon: Image, label: '큰 아이콘' },
]

// ── Thumbnail component (shared by grid/icon views) ──

function Thumbnail({ path, size = 'md' }: { path: string; size?: 'sm' | 'md' | 'lg' }) {
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const iconSize = size === 'sm' ? 'w-6 h-6' : size === 'md' ? 'w-10 h-10' : 'w-14 h-14'

  if (error) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <FileVideo className={`${iconSize} text-dark-600`} />
      </div>
    )
  }

  return (
    <>
      <img
        src={getThumbnailUrl(path)}
        alt=""
        loading="lazy"
        onError={() => setError(true)}
        onLoad={() => setLoaded(true)}
        className={`w-full h-full object-cover transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
      />
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center">
          <FileVideo className={`${iconSize} text-dark-600 animate-pulse`} />
        </div>
      )}
    </>
  )
}

// ── Details View (list) ──

function DetailsView({ entries, onClickEntry }: { entries: FileEntry[]; onClickEntry: (e: FileEntry) => void }) {
  return (
    <div className="bg-dark-900 border border-dark-700 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="grid grid-cols-[1fr_100px] sm:grid-cols-[1fr_100px_120px] px-4 py-2 border-b border-dark-700 text-xs text-gray-500 uppercase tracking-wider">
        <span>Name</span>
        <span className="text-right">Size</span>
        <span className="text-right hidden sm:block">Type</span>
      </div>
      {/* Rows */}
      {entries.map((entry) => {
        const isVideo = !entry.is_dir && isVideoFile(entry.name)
        const Icon = entry.is_dir ? Folder : isVideo ? FileVideo : File
        const iconColor = entry.is_dir ? 'text-yellow-400' : isVideo ? 'text-blue-400' : 'text-gray-500'
        const fileType = entry.is_dir ? 'Folder' : entry.name.split('.').pop()?.toUpperCase() || 'File'

        return (
          <button
            key={entry.path}
            onClick={() => onClickEntry(entry)}
            className="grid grid-cols-[1fr_100px] sm:grid-cols-[1fr_100px_120px] px-4 py-2 hover:bg-dark-800 transition-colors text-left w-full border-b border-dark-800 last:border-b-0 group"
          >
            <div className="flex items-center gap-2 min-w-0">
              <Icon className={`w-4 h-4 ${iconColor} shrink-0`} />
              <span className="text-sm text-gray-200 truncate group-hover:text-white">{entry.name}</span>
            </div>
            <span className="text-sm text-gray-500 text-right">
              {!entry.is_dir && entry.size ? formatBytes(entry.size) : ''}
            </span>
            <span className="text-sm text-gray-500 text-right hidden sm:block">{fileType}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Small Icons View ──

function SmallIconsView({ entries, onClickEntry }: { entries: FileEntry[]; onClickEntry: (e: FileEntry) => void }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
      {entries.map((entry) => {
        const isVideo = !entry.is_dir && isVideoFile(entry.name)
        const Icon = entry.is_dir ? Folder : isVideo ? FileVideo : File
        const iconColor = entry.is_dir ? 'text-yellow-400' : isVideo ? 'text-blue-400' : 'text-gray-500'

        return (
          <button
            key={entry.path}
            onClick={() => onClickEntry(entry)}
            className="bg-dark-900 border border-dark-700 rounded-lg overflow-hidden hover:bg-dark-800 hover:border-dark-600 transition-colors text-left group"
          >
            {isVideo ? (
              <div className="relative aspect-video bg-dark-800 overflow-hidden">
                <Thumbnail path={entry.path} size="sm" />
                {/* Play icon on hover */}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                  <Play className="w-4 h-4 text-white opacity-0 group-hover:opacity-100 transition-opacity" fill="currentColor" />
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center py-3 bg-dark-800">
                <Icon className={`w-8 h-8 ${iconColor}`} />
              </div>
            )}
            <div className="px-2 py-1.5">
              <p className="text-xs text-gray-300 truncate group-hover:text-white" title={entry.name}>
                {entry.name}
              </p>
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ── Grid View (medium cards) ──

function GridView({ entries, onClickEntry }: { entries: FileEntry[]; onClickEntry: (e: FileEntry) => void }) {
  // Separate dirs from files for grid view
  const dirs = entries.filter(e => e.is_dir)
  const files = entries.filter(e => !e.is_dir)

  return (
    <>
      {/* Directories - compact */}
      {dirs.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2 mb-4">
          {dirs.map((entry) => (
            <button
              key={entry.path}
              onClick={() => onClickEntry(entry)}
              className="bg-dark-900 border border-dark-700 rounded-lg px-3 py-2.5 hover:bg-dark-800 hover:border-dark-600 transition-colors text-left group"
            >
              <div className="flex items-center gap-2">
                <Folder className="w-5 h-5 text-yellow-400 shrink-0" />
                <p className="text-sm text-gray-200 truncate group-hover:text-white">
                  {entry.name}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
      {/* Files - medium thumbnail cards */}
      {files.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {files.map((entry) => {
            const isVideo = isVideoFile(entry.name)
            return (
              <button
                key={entry.path}
                onClick={() => onClickEntry(entry)}
                className="bg-dark-900 border border-dark-700 rounded-lg overflow-hidden hover:bg-dark-800 hover:border-dark-600 transition-all text-left group hover:scale-[1.02]"
              >
                {isVideo ? (
                  <div className="relative aspect-video bg-dark-800 overflow-hidden">
                    <Thumbnail path={entry.path} size="md" />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                      <div className="w-12 h-12 rounded-full bg-white/90 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-lg">
                        <Play className="w-5 h-5 text-black ml-0.5" fill="currentColor" />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-center py-8 bg-dark-800">
                    <File className="w-12 h-12 text-gray-500" />
                  </div>
                )}
                <div className="p-3">
                  <p className="text-sm text-gray-200 truncate group-hover:text-white" title={entry.name}>
                    {entry.name}
                  </p>
                  {entry.size && (
                    <p className="text-xs text-gray-500 mt-0.5">
                      {formatBytes(entry.size)}
                    </p>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}

// ── Large Icons View ──

function LargeIconsView({ entries, onClickEntry }: { entries: FileEntry[]; onClickEntry: (e: FileEntry) => void }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {entries.map((entry) => {
        const isVideo = !entry.is_dir && isVideoFile(entry.name)
        const Icon = entry.is_dir ? Folder : File

        return (
          <button
            key={entry.path}
            onClick={() => onClickEntry(entry)}
            className="bg-dark-900 border border-dark-700 rounded-xl overflow-hidden hover:bg-dark-800 hover:border-dark-600 transition-all text-left group hover:scale-[1.01]"
          >
            {isVideo ? (
              <div className="relative aspect-video bg-dark-800 overflow-hidden">
                <Thumbnail path={entry.path} size="lg" />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                  <div className="w-16 h-16 rounded-full bg-white/90 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-xl">
                    <Play className="w-7 h-7 text-black ml-1" fill="currentColor" />
                  </div>
                </div>
              </div>
            ) : entry.is_dir ? (
              <div className="flex items-center justify-center py-16 bg-dark-800">
                <Folder className="w-20 h-20 text-yellow-400/70" />
              </div>
            ) : (
              <div className="flex items-center justify-center py-16 bg-dark-800">
                <Icon className="w-20 h-20 text-gray-600" />
              </div>
            )}
            <div className="p-4">
              <p className="text-base text-gray-200 truncate group-hover:text-white" title={entry.name}>
                {entry.name}
              </p>
              {!entry.is_dir && entry.size && (
                <p className="text-sm text-gray-500 mt-1">
                  {formatBytes(entry.size)}
                </p>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ── Main Browse Page ──

export default function Browse() {
  const params = useParams()
  const path = params['*'] || ''
  const navigate = useNavigate()
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    (localStorage.getItem('ftml-view-mode') as ViewMode) || 'grid'
  )

  useEffect(() => {
    setLoading(true)
    getTree(path)
      .then(({ data }) => setEntries(data.entries || []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false))
  }, [path])

  const handleViewMode = (mode: ViewMode) => {
    setViewMode(mode)
    localStorage.setItem('ftml-view-mode', mode)
  }

  const handleClick = (entry: FileEntry) => {
    if (entry.is_dir) {
      navigate(`/browse/${entry.path}`)
    } else if (isVideoFile(entry.name)) {
      navigate(`/watch/${entry.path}`)
    }
  }

  const goUp = () => {
    const parts = path.split('/')
    parts.pop()
    navigate(parts.length > 0 ? `/browse/${parts.join('/')}` : '/')
  }

  if (loading) {
    return <div className="text-gray-400">Loading...</div>
  }

  return (
    <div>
      {/* Header: back button + view mode toggles */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          {path && (
            <>
              <button onClick={goUp} className="text-gray-400 hover:text-white transition-colors">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h2 className="text-lg text-gray-300 font-medium truncate">
                {path.split('/').pop()}
              </h2>
            </>
          )}
        </div>

        {/* View mode toggles */}
        <div className="flex items-center gap-1 bg-dark-900 border border-dark-700 rounded-lg p-0.5">
          {VIEW_MODES.map(({ value, icon: ModeIcon, label }) => (
            <button
              key={value}
              onClick={() => handleViewMode(value)}
              title={label}
              className={`p-1.5 rounded transition-colors ${
                viewMode === value
                  ? 'bg-primary-600 text-white'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-dark-800'
              }`}
            >
              <ModeIcon className="w-4 h-4" />
            </button>
          ))}
        </div>
      </div>

      {/* Content area */}
      {viewMode === 'details' && (
        <DetailsView entries={entries} onClickEntry={handleClick} />
      )}
      {viewMode === 'small-icons' && (
        <SmallIconsView entries={entries} onClickEntry={handleClick} />
      )}
      {viewMode === 'grid' && (
        <GridView entries={entries} onClickEntry={handleClick} />
      )}
      {viewMode === 'large-icons' && (
        <LargeIconsView entries={entries} onClickEntry={handleClick} />
      )}

      {entries.length === 0 && (
        <div className="text-center text-gray-500 mt-16">
          <Folder className="w-16 h-16 mx-auto mb-4 opacity-30" />
          <p>This folder is empty</p>
        </div>
      )}
    </div>
  )
}
