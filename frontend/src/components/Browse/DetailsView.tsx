import { useState, useEffect, useRef, useCallback } from 'react'
import { Folder, FileVideo, File, ChevronUp, ChevronDown } from 'lucide-react'
import { type FileEntry, type MediaInfo, batchFileInfo } from '@/api/files'
import { useBrowseStore, type ColumnDef, DEFAULT_COLUMNS } from '@/stores/browseStore'
import { isVideoFile, formatBytes, formatDuration } from '@/utils/format'

interface DetailsViewProps {
  entries: FileEntry[]
  onClickEntry: (entry: FileEntry) => void
}

// Extract cell value for a given column
function getCellValue(
  entry: FileEntry,
  columnId: string,
  mediaInfo?: MediaInfo | null
): string {
  switch (columnId) {
    case 'name':
      return entry.name
    case 'size':
      return !entry.is_dir && entry.size ? formatBytes(entry.size) : ''
    case 'type':
      return entry.is_dir
        ? 'Folder'
        : entry.name.split('.').pop()?.toUpperCase() || 'File'
    case 'duration':
      if (!mediaInfo?.duration) return ''
      return formatDuration(parseFloat(mediaInfo.duration))
    case 'resolution':
      if (!mediaInfo?.width || !mediaInfo?.height) return ''
      return `${mediaInfo.width}x${mediaInfo.height}`
    case 'videoCodec':
      return mediaInfo?.video_codec || ''
    case 'bitrate':
      if (!mediaInfo?.bit_rate) return ''
      const kbps = parseInt(mediaInfo.bit_rate) / 1000
      return kbps >= 1000
        ? `${(kbps / 1000).toFixed(1)} Mbps`
        : `${Math.round(kbps)} kbps`
    case 'audioCodec':
      return mediaInfo?.audio_codec || ''
    case 'frameRate':
      if (!mediaInfo?.frame_rate) return ''
      // frame_rate might be "24000/1001" or "30/1"
      const parts = mediaInfo.frame_rate.split('/')
      if (parts.length === 2) {
        const fps = parseFloat(parts[0]) / parseFloat(parts[1])
        return `${fps.toFixed(2)} fps`
      }
      return `${mediaInfo.frame_rate} fps`
    default:
      return ''
  }
}

// Check if a column needs media info
function needsMediaInfo(columnId: string): boolean {
  return ['duration', 'resolution', 'videoCodec', 'bitrate', 'audioCodec', 'frameRate'].includes(columnId)
}

type SortDir = 'asc' | 'desc'

export default function DetailsView({ entries, onClickEntry }: DetailsViewProps) {
  const { columns, toggleColumn, resizeColumn, reorderColumns } = useBrowseStore()
  const visibleColumns = columns.filter((c) => c.visible)

  // Sorting
  const [sortCol, setSortCol] = useState<string>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  // Column resize
  const [resizing, setResizing] = useState<{ id: string; startX: number; startW: number } | null>(null)

  // Column drag reorder
  const [dragCol, setDragCol] = useState<number | null>(null)
  const [dragOverCol, setDragOverCol] = useState<number | null>(null)

  // Media info cache
  const [mediaInfoMap, setMediaInfoMap] = useState<Map<string, MediaInfo>>(new Map())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const fetchedRef = useRef<Set<string>>(new Set())

  // Check if any visible column needs media info
  const hasMediaColumns = visibleColumns.some((c) => needsMediaInfo(c.id))

  // Batch load media info for video files
  useEffect(() => {
    if (!hasMediaColumns) return

    const videoPaths = entries
      .filter((e) => !e.is_dir && isVideoFile(e.name))
      .map((e) => e.path)
      .filter((p) => !fetchedRef.current.has(p))

    if (videoPaths.length === 0) return

    // Mark as fetching
    videoPaths.forEach((p) => fetchedRef.current.add(p))
    setLoadingPaths((prev) => new Set([...prev, ...videoPaths]))

    // Batch in groups of 20
    const batches: string[][] = []
    for (let i = 0; i < videoPaths.length; i += 20) {
      batches.push(videoPaths.slice(i, i + 20))
    }

    batches.forEach((batch) => {
      batchFileInfo(batch)
        .then(({ data }) => {
          setMediaInfoMap((prev) => {
            const next = new Map(prev)
            data.forEach((r) => {
              if (r.info) next.set(r.path, r.info)
            })
            return next
          })
          setLoadingPaths((prev) => {
            const next = new Set(prev)
            batch.forEach((p) => next.delete(p))
            return next
          })
        })
        .catch(() => {
          setLoadingPaths((prev) => {
            const next = new Set(prev)
            batch.forEach((p) => next.delete(p))
            return next
          })
        })
    })
  }, [entries, hasMediaColumns])

  // Reset media info cache when entries change
  useEffect(() => {
    setMediaInfoMap(new Map())
    fetchedRef.current = new Set()
  }, [entries])

  // Sort entries
  const sortedEntries = [...entries].sort((a, b) => {
    // Directories always first
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1

    const valA = getCellValue(a, sortCol, mediaInfoMap.get(a.path))
    const valB = getCellValue(b, sortCol, mediaInfoMap.get(b.path))

    // Numeric comparison for size
    if (sortCol === 'size') {
      const numA = a.size || 0
      const numB = b.size || 0
      return sortDir === 'asc' ? numA - numB : numB - numA
    }

    // String comparison
    const cmp = valA.localeCompare(valB, undefined, { numeric: true })
    return sortDir === 'asc' ? cmp : -cmp
  })

  // Handle header click for sorting
  const handleSort = (colId: string) => {
    if (sortCol === colId) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortCol(colId)
      setSortDir('asc')
    }
  }

  // Handle header right-click for column toggle menu
  const handleHeaderContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return
    const handleClick = () => setContextMenu(null)
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [contextMenu])

  // Column resize handlers
  const handleResizeStart = useCallback(
    (e: React.MouseEvent, col: ColumnDef) => {
      e.preventDefault()
      e.stopPropagation()
      setResizing({ id: col.id, startX: e.clientX, startW: col.width })
    },
    []
  )

  useEffect(() => {
    if (!resizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - resizing.startX
      resizeColumn(resizing.id, resizing.startW + delta)
    }

    const handleMouseUp = () => {
      setResizing(null)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [resizing, resizeColumn])

  // Column drag reorder handlers
  const handleDragStart = (e: React.DragEvent, idx: number) => {
    setDragCol(idx)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault()
    setDragOverCol(idx)
  }

  const handleDrop = (e: React.DragEvent, toIdx: number) => {
    e.preventDefault()
    if (dragCol !== null && dragCol !== toIdx) {
      // Convert visible index to full column array index
      const fromColId = visibleColumns[dragCol].id
      const toColId = visibleColumns[toIdx].id
      const fromFullIdx = columns.findIndex((c) => c.id === fromColId)
      const toFullIdx = columns.findIndex((c) => c.id === toColId)
      if (fromFullIdx >= 0 && toFullIdx >= 0) {
        reorderColumns(fromFullIdx, toFullIdx)
      }
    }
    setDragCol(null)
    setDragOverCol(null)
  }

  const handleDragEnd = () => {
    setDragCol(null)
    setDragOverCol(null)
  }

  // Build grid template - Name column is flexible, others are fixed width
  const gridTemplate = visibleColumns
    .map((c) => c.id === 'name' ? `minmax(150px, 1fr)` : `${c.width}px`)
    .join(' ')

  return (
    <div className="bg-dark-900 border border-dark-700 rounded-lg overflow-x-auto">
      {/* Header */}
      <div
        className="grid px-2 py-2 border-b border-dark-700 text-xs text-gray-500 uppercase tracking-wider select-none"
        style={{ gridTemplateColumns: gridTemplate }}
        onContextMenu={handleHeaderContextMenu}
      >
        {visibleColumns.map((col, idx) => (
          <div
            key={col.id}
            className={`relative flex items-center gap-1 px-2 cursor-pointer hover:text-gray-300 transition-colors ${
              dragOverCol === idx ? 'bg-dark-700' : ''
            }`}
            onClick={() => handleSort(col.id)}
            draggable
            onDragStart={(e) => handleDragStart(e, idx)}
            onDragOver={(e) => handleDragOver(e, idx)}
            onDrop={(e) => handleDrop(e, idx)}
            onDragEnd={handleDragEnd}
          >
            <span className="truncate">{col.label}</span>
            {sortCol === col.id && (
              sortDir === 'asc'
                ? <ChevronUp className="w-3 h-3 shrink-0" />
                : <ChevronDown className="w-3 h-3 shrink-0" />
            )}
            {/* Resize handle */}
            <div
              className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary-500/50 transition-colors"
              onMouseDown={(e) => handleResizeStart(e, col)}
            />
          </div>
        ))}
      </div>

      {/* Rows */}
      {sortedEntries.map((entry) => {
        const isVideo = !entry.is_dir && isVideoFile(entry.name)
        const Icon = entry.is_dir ? Folder : isVideo ? FileVideo : File
        const iconColor = entry.is_dir
          ? 'text-yellow-400'
          : isVideo
          ? 'text-blue-400'
          : 'text-gray-500'
        const info = mediaInfoMap.get(entry.path)
        const isLoading = loadingPaths.has(entry.path)

        return (
          <button
            key={entry.path}
            onClick={() => onClickEntry(entry)}
            className="grid px-2 py-1.5 hover:bg-dark-800 transition-colors text-left w-full border-b border-dark-800 last:border-b-0 group"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {visibleColumns.map((col) => {
              // Name column gets special treatment with icon
              if (col.id === 'name') {
                return (
                  <div key={col.id} className="flex items-center gap-2 min-w-0 px-2">
                    <Icon className={`w-4 h-4 ${iconColor} shrink-0`} />
                    <span className="text-sm text-gray-200 truncate group-hover:text-white">
                      {entry.name}
                    </span>
                  </div>
                )
              }

              const isMediaCol = needsMediaInfo(col.id)
              const showShimmer = isMediaCol && isVideo && isLoading && !info

              return (
                <div key={col.id} className="flex items-center px-2 min-w-0">
                  {showShimmer ? (
                    <div className="h-3 w-16 bg-dark-700 rounded animate-pulse" />
                  ) : (
                    <span className="text-sm text-gray-500 truncate">
                      {getCellValue(entry, col.id, info)}
                    </span>
                  )}
                </div>
              )
            })}
          </button>
        )
      })}

      {/* Context menu for column toggle */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-dark-800 border border-dark-600 rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {DEFAULT_COLUMNS.map((def) => {
            const col = columns.find((c) => c.id === def.id)
            const isVisible = col?.visible ?? def.visible
            const isName = def.id === 'name'

            return (
              <button
                key={def.id}
                onClick={(e) => {
                  e.stopPropagation()
                  if (!isName) toggleColumn(def.id)
                }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-dark-700 transition-colors ${
                  isName ? 'opacity-50 cursor-not-allowed' : ''
                }`}
                disabled={isName}
              >
                <div
                  className={`w-3.5 h-3.5 rounded border ${
                    isVisible
                      ? 'bg-primary-500 border-primary-500'
                      : 'border-dark-500'
                  } flex items-center justify-center`}
                >
                  {isVisible && (
                    <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 12 12" fill="none">
                      <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>
                <span className="text-gray-300">{def.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
