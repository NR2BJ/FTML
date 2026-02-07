import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getTree, getThumbnailUrl, type FileEntry } from '@/api/files'
import { Folder, FileVideo, File, ArrowLeft, Play, List, LayoutGrid, CheckSquare } from 'lucide-react'
import { isVideoFile, formatBytes } from '@/utils/format'
import { useBrowseStore } from '@/stores/browseStore'
import DetailsView from '@/components/Browse/DetailsView'
import ContextMenu from '@/components/Browse/ContextMenu'
import BatchSubtitleDialog from '@/components/Browse/BatchSubtitleDialog'

// ── Thumbnail component ──

function Thumbnail({ path, iconSize }: { path: string; iconSize: number }) {
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)

  // Scale play button based on icon size
  const playSize = Math.max(20, Math.min(48, iconSize * 0.22))

  if (error) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <FileVideo className="w-8 h-8 text-dark-600" />
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
          <FileVideo className="w-8 h-8 text-dark-600 animate-pulse" />
        </div>
      )}
      {/* Play overlay on hover */}
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
        <div
          className="rounded-full bg-white/90 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-lg"
          style={{ width: playSize, height: playSize }}
        >
          <Play
            className="text-black"
            fill="currentColor"
            style={{ width: playSize * 0.5, height: playSize * 0.5, marginLeft: playSize * 0.05 }}
          />
        </div>
      </div>
    </>
  )
}

// ── Icons View (slider-controlled size) ──

function IconsView({ entries, onClickEntry, iconSize, selectedPaths, onSelectionChange, onContextMenu }: {
  entries: FileEntry[]
  onClickEntry: (e: FileEntry) => void
  iconSize: number
  selectedPaths: Set<string>
  onSelectionChange: (paths: Set<string>) => void
  onContextMenu: (e: React.MouseEvent, entries: FileEntry[]) => void
}) {
  // Scale font and padding based on icon size
  const fontSize = Math.max(11, Math.min(14, iconSize * 0.07))
  const padding = Math.max(4, Math.min(12, iconSize * 0.05))

  const handleContextMenu = (e: React.MouseEvent, entry: FileEntry) => {
    if (!isVideoFile(entry.name) || entry.is_dir) return
    e.preventDefault()
    if (!selectedPaths.has(entry.path)) {
      onSelectionChange(new Set([entry.path]))
      onContextMenu(e, [entry])
    } else {
      const selected = entries.filter(en => selectedPaths.has(en.path))
      onContextMenu(e, selected)
    }
  }

  const toggleSelection = (e: React.MouseEvent, entry: FileEntry) => {
    e.stopPropagation()
    const next = new Set(selectedPaths)
    if (next.has(entry.path)) next.delete(entry.path)
    else next.add(entry.path)
    onSelectionChange(next)
  }

  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${iconSize}px, 1fr))` }}
    >
      {entries.map((entry) => {
        const isVideo = !entry.is_dir && isVideoFile(entry.name)
        const Icon = entry.is_dir ? Folder : isVideo ? FileVideo : File
        const iconColor = entry.is_dir ? 'text-yellow-400' : isVideo ? 'text-blue-400' : 'text-gray-500'
        const isSelected = selectedPaths.has(entry.path)

        return (
          <button
            key={entry.path}
            onClick={() => onClickEntry(entry)}
            onContextMenu={(e) => handleContextMenu(e, entry)}
            className={`bg-dark-900 border rounded-lg overflow-hidden hover:bg-dark-800 hover:border-dark-600 transition-colors text-left group relative ${
              isSelected ? 'border-primary-500 bg-primary-900/10' : 'border-dark-700'
            }`}
          >
            {/* Selection checkbox overlay */}
            {isVideo && (
              <div
                className={`absolute top-1.5 right-1.5 z-10 transition-opacity ${
                  isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-70'
                }`}
                onClick={(e) => toggleSelection(e, entry)}
              >
                <div className={`w-5 h-5 rounded border flex items-center justify-center ${
                  isSelected
                    ? 'bg-primary-500 border-primary-500'
                    : 'bg-dark-900/80 border-dark-500'
                }`}>
                  {isSelected && (
                    <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
                      <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>
              </div>
            )}

            {isVideo ? (
              <div className="relative aspect-video bg-dark-800 overflow-hidden">
                <Thumbnail path={entry.path} iconSize={iconSize} />
              </div>
            ) : entry.is_dir ? (
              <div className="flex items-center justify-center aspect-video bg-dark-800">
                <Folder
                  className="text-yellow-400/70"
                  style={{ width: iconSize * 0.3, height: iconSize * 0.3 }}
                />
              </div>
            ) : (
              <div className="flex items-center justify-center aspect-video bg-dark-800">
                <Icon
                  className={iconColor}
                  style={{ width: iconSize * 0.25, height: iconSize * 0.25 }}
                />
              </div>
            )}
            <div style={{ padding: `${padding}px ${padding + 2}px` }}>
              <p
                className="text-gray-300 truncate group-hover:text-white"
                style={{ fontSize }}
                title={entry.name}
              >
                {entry.name}
              </p>
              {iconSize >= 180 && !entry.is_dir && entry.size && (
                <p className="text-gray-600 mt-0.5" style={{ fontSize: fontSize - 1 }}>
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

type BatchMode = 'generate' | 'translate' | 'generate-translate'

export default function Browse() {
  const params = useParams()
  const path = params['*'] || ''
  const navigate = useNavigate()
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entries: FileEntry[] } | null>(null)
  const [batchDialog, setBatchDialog] = useState<{ mode: BatchMode; files: FileEntry[] } | null>(null)

  const { viewMode, iconSize, setViewMode, setIconSize } = useBrowseStore()

  useEffect(() => {
    setLoading(true)
    getTree(path)
      .then(({ data }) => setEntries(data.entries || []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false))
  }, [path])

  // Reset selection when changing directory
  useEffect(() => {
    setSelectedPaths(new Set())
  }, [path])

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

  const handleContextMenu = useCallback((e: React.MouseEvent, contextEntries: FileEntry[]) => {
    setContextMenu({ x: e.clientX, y: e.clientY, entries: contextEntries })
  }, [])

  const openBatchDialog = (mode: BatchMode) => {
    const files = entries.filter(e => selectedPaths.has(e.path))
    if (files.length > 0) {
      setBatchDialog({ mode, files })
    }
  }

  const selectedCount = selectedPaths.size

  if (loading) {
    return <div className="text-gray-400">Loading...</div>
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 gap-3">
        <div className="flex items-center gap-2 min-w-0">
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

        <div className="flex items-center gap-3 shrink-0">
          {/* Selected count + batch action */}
          {selectedCount > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-primary-400 flex items-center gap-1">
                <CheckSquare className="w-3.5 h-3.5" />
                {selectedCount} selected
              </span>
              <button
                onClick={() => setSelectedPaths(new Set())}
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                Clear
              </button>
            </div>
          )}

          {/* Icon size slider (only in icons mode) */}
          {viewMode === 'icons' && (
            <div className="flex items-center gap-2">
              <LayoutGrid className="w-3.5 h-3.5 text-gray-500" />
              <input
                type="range"
                min="100"
                max="400"
                step="10"
                value={iconSize}
                onChange={(e) => setIconSize(parseInt(e.target.value, 10))}
                className="w-24 h-1 bg-dark-700 rounded-lg appearance-none cursor-pointer accent-primary-500"
              />
              <LayoutGrid className="w-4.5 h-4.5 text-gray-500" />
            </div>
          )}

          {/* View mode toggles */}
          <div className="flex items-center gap-0.5 bg-dark-900 border border-dark-700 rounded-lg p-0.5">
            <button
              onClick={() => setViewMode('icons')}
              title="Icons"
              className={`p-1.5 rounded transition-colors ${
                viewMode === 'icons'
                  ? 'bg-primary-600 text-white'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-dark-800'
              }`}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('details')}
              title="Details"
              className={`p-1.5 rounded transition-colors ${
                viewMode === 'details'
                  ? 'bg-primary-600 text-white'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-dark-800'
              }`}
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      {viewMode === 'icons' && (
        <IconsView
          entries={entries}
          onClickEntry={handleClick}
          iconSize={iconSize}
          selectedPaths={selectedPaths}
          onSelectionChange={setSelectedPaths}
          onContextMenu={handleContextMenu}
        />
      )}
      {viewMode === 'details' && (
        <DetailsView
          entries={entries}
          onClickEntry={handleClick}
          selectedPaths={selectedPaths}
          onSelectionChange={setSelectedPaths}
          onContextMenu={handleContextMenu}
        />
      )}

      {entries.length === 0 && (
        <div className="text-center text-gray-500 mt-16">
          <Folder className="w-16 h-16 mx-auto mb-4 opacity-30" />
          <p>This folder is empty</p>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          selectedEntries={contextMenu.entries}
          onClose={() => setContextMenu(null)}
          onGenerateSubtitles={() => openBatchDialog('generate')}
          onTranslateSubtitles={() => openBatchDialog('translate')}
          onGenerateAndTranslate={() => openBatchDialog('generate-translate')}
        />
      )}

      {/* Batch Subtitle Dialog */}
      {batchDialog && (
        <BatchSubtitleDialog
          mode={batchDialog.mode}
          files={batchDialog.files}
          onClose={() => setBatchDialog(null)}
        />
      )}
    </div>
  )
}
