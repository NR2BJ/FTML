import { encodeMediaPath } from '@/utils/mediaPath'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getTree, getThumbnailUrl, batchFileInfo, type FileEntry, type MediaInfo } from '@/api/files'
import { Folder, FileVideo, File, ArrowLeft, Play, List, LayoutGrid, CheckSquare, Subtitles, Home, ChevronRight, Loader2 } from 'lucide-react'
import { isVideoFile, formatBytes } from '@/utils/format'
import { useBrowseStore } from '@/stores/browseStore'
import DetailsView from '@/components/Browse/DetailsView'
import ContextMenu from '@/components/Browse/ContextMenu'
import BatchSubtitleDialog from '@/components/Browse/BatchSubtitleDialog'

// ── Badge helper ──

function getBadges(info: MediaInfo): string[] {
  const badges: string[] = []
  // Resolution
  if (info.height >= 2160) badges.push('4K')
  else if (info.height >= 1080) badges.push('1080p')
  else if (info.height >= 720) badges.push('720p')
  else if (info.height >= 480) badges.push('480p')
  // Video codec
  const vc = (info.video_codec || '').toLowerCase()
  if (vc.includes('hevc') || vc.includes('h265') || vc === 'h265') badges.push('HEVC')
  else if (vc.includes('av1')) badges.push('AV1')
  else if (vc.includes('vp9')) badges.push('VP9')
  // HDR (10-bit or higher pixel format)
  const pf = (info.pix_fmt || '').toLowerCase()
  if (pf.includes('10le') || pf.includes('10be') || pf.includes('p010') || pf.includes('12le') || pf.includes('12be')) {
    badges.push('HDR')
  }
  return badges
}

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

function IconsView({ entries, onClickEntry, iconSize, selectedPaths, onSelectionChange, onContextMenu, mediaInfoMap }: {
  entries: FileEntry[]
  onClickEntry: (e: FileEntry) => void
  iconSize: number
  selectedPaths: Set<string>
  onSelectionChange: (paths: Set<string>) => void
  onContextMenu: (e: React.MouseEvent, entries: FileEntry[]) => void
  mediaInfoMap?: Map<string, MediaInfo>
}) {
  // Scale font and padding based on icon size
  const fontSize = Math.max(11, Math.min(14, iconSize * 0.07))
  const padding = Math.max(4, Math.min(12, iconSize * 0.05))

  const handleContextMenu = (e: React.MouseEvent, entry: FileEntry) => {
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
                {/* Codec/Resolution badges */}
                {mediaInfoMap?.get(entry.path) && (() => {
                  const badges = getBadges(mediaInfoMap.get(entry.path)!)
                  return badges.length > 0 ? (
                    <div className="absolute bottom-1 left-1 flex gap-0.5 z-[5]">
                      {badges.map((b) => (
                        <span key={b} className="bg-black/70 text-[10px] text-gray-200 font-medium px-1 rounded leading-tight">
                          {b}
                        </span>
                      ))}
                    </div>
                  ) : null
                })()}
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
  const [batchDialog, setBatchDialog] = useState<{ mode: BatchMode; files: FileEntry[]; subtitleId?: string } | null>(null)
  const { viewMode, iconSize, setViewMode, setIconSize } = useBrowseStore()

  // Media info for badges (icons view)
  const [mediaInfoMap, setMediaInfoMap] = useState<Map<string, MediaInfo>>(new Map())
  const badgeFetchedRef = useRef<Set<string>>(new Set())

  // Batch fetch media info for video files (badges in icons view)
  useEffect(() => {
    if (viewMode !== 'icons') return

    const videoPaths = entries
      .filter((e) => !e.is_dir && isVideoFile(e.name))
      .map((e) => e.path)
      .filter((p) => !badgeFetchedRef.current.has(p))

    if (videoPaths.length === 0) return

    videoPaths.forEach((p) => badgeFetchedRef.current.add(p))

    // Batch in groups of 20
    for (let i = 0; i < videoPaths.length; i += 20) {
      const batch = videoPaths.slice(i, i + 20)
      batchFileInfo(batch)
        .then(({ data }) => {
          setMediaInfoMap((prev) => {
            const next = new Map(prev)
            data.forEach((r) => {
              if (r.info) next.set(r.path, r.info)
            })
            return next
          })
        })
        .catch(() => {})
    }
  }, [entries, viewMode])

  // Reset media info when path changes
  useEffect(() => {
    setMediaInfoMap(new Map())
    badgeFetchedRef.current = new Set()
  }, [path])

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
      navigate(`/browse/${encodeMediaPath(entry.path)}`)
    } else if (isVideoFile(entry.name)) {
      navigate(`/watch/${encodeMediaPath(entry.path)}`)
    }
  }

  const goUp = () => {
    const parts = path.split('/')
    parts.pop()
    navigate(parts.length > 0 ? `/browse/${encodeMediaPath(parts.join('/'))}` : '/')
  }

  const handleContextMenu = useCallback((e: React.MouseEvent, contextEntries: FileEntry[]) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, entries: contextEntries })
  }, [])

  const openBatchDialog = (mode: BatchMode) => {
    // Use context menu entries (set at right-click time) if available
    const files = (contextMenu?.entries ?? entries.filter(e => selectedPaths.has(e.path)))
      .filter(e => !e.is_dir && isVideoFile(e.name))
    if (files.length > 0) {
      setBatchDialog({ mode, files })
    }
  }

  const selectedCount = selectedPaths.size

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="relative">
      {/* Header with breadcrumb */}
      <div className="flex items-center justify-between mb-4 gap-3">
        <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
          {path && (
            <button onClick={goUp} className="text-gray-400 hover:text-white transition-colors shrink-0 mr-1">
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          <button
            onClick={() => navigate('/')}
            className="text-gray-400 hover:text-white transition-colors shrink-0"
            title="Home"
          >
            <Home className="w-4 h-4" />
          </button>
          {path && (() => {
            const segments = path.split('/')
            return segments.map((seg, i) => {
              const isLast = i === segments.length - 1
              const segPath = segments.slice(0, i + 1).join('/')
              return (
                <span key={i} className="flex items-center gap-1.5 min-w-0">
                  <ChevronRight className="w-3.5 h-3.5 text-gray-600 shrink-0" />
                  {isLast ? (
                    <span className="text-sm font-medium text-white truncate">{seg}</span>
                  ) : (
                    <button
                      onClick={() => navigate(`/browse/${encodeMediaPath(segPath)}`)}
                      className="text-sm text-gray-400 hover:text-white transition-colors truncate"
                    >
                      {seg}
                    </button>
                  )}
                </span>
              )
            })
          })()}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {/* Selected count + batch action */}
          {selectedCount > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-primary-400 flex items-center gap-1">
                <CheckSquare className="w-3.5 h-3.5" />
                {selectedCount} selected
              </span>
                {entries.some(e => selectedPaths.has(e.path) && !e.is_dir && isVideoFile(e.name)) && (
                  <button onClick={() => openBatchDialog('generate')} className="flex items-center gap-1 rounded px-2 py-1 text-sm text-primary-400"><Subtitles size={16} />자막 패널</button>
                )}
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
          mediaInfoMap={mediaInfoMap}
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
          onSubtitles={() => openBatchDialog('generate')}
        />
      )}

      {/* Batch Subtitle Dialog */}
      {batchDialog && (
        <BatchSubtitleDialog
          mode={batchDialog.mode}
          files={batchDialog.files}
          subtitleId={batchDialog.subtitleId}
          onClose={() => setBatchDialog(null)}
        />
      )}

    </div>
  )
}
