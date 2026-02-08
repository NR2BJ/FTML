import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getTree, getThumbnailUrl, type FileEntry, uploadFile, deleteFile, moveFile, createFolder } from '@/api/files'
import { Folder, FileVideo, File, ArrowLeft, Play, List, LayoutGrid, CheckSquare, Upload, FolderPlus } from 'lucide-react'
import { isVideoFile, formatBytes } from '@/utils/format'
import { useBrowseStore } from '@/stores/browseStore'
import { useAuthStore } from '@/stores/authStore'
import DetailsView from '@/components/Browse/DetailsView'
import ContextMenu from '@/components/Browse/ContextMenu'
import BatchSubtitleDialog from '@/components/Browse/BatchSubtitleDialog'
import SubtitleManagerDialog from '@/components/Browse/SubtitleManagerDialog'

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
  const [subtitleManager, setSubtitleManager] = useState<FileEntry | null>(null)

  // File management state
  const { user } = useAuthStore()
  const isAdmin = user?.role === 'admin'
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [newFolderName, setNewFolderName] = useState<string | null>(null)
  const [renameEntry, setRenameEntry] = useState<FileEntry | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<FileEntry[] | null>(null)
  const [actionError, setActionError] = useState('')

  const { viewMode, iconSize, setViewMode, setIconSize } = useBrowseStore()

  const refreshEntries = useCallback(() => {
    getTree(path)
      .then(({ data }) => setEntries(data.entries || []))
      .catch(() => setEntries([]))
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

  // File management handlers
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setActionError('')
    setUploadProgress(0)
    try {
      await uploadFile(path, file, (pct) => setUploadProgress(pct))
      refreshEntries()
    } catch {
      setActionError('Upload failed')
    } finally {
      setUploadProgress(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleCreateFolder = async () => {
    if (!newFolderName?.trim()) { setNewFolderName(null); return }
    setActionError('')
    try {
      const folderPath = path ? `${path}/${newFolderName.trim()}` : newFolderName.trim()
      await createFolder(folderPath)
      refreshEntries()
    } catch {
      setActionError('Failed to create folder')
    } finally {
      setNewFolderName(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteConfirm) return
    setActionError('')
    try {
      for (const entry of deleteConfirm) {
        await deleteFile(entry.path)
      }
      setSelectedPaths(new Set())
      refreshEntries()
    } catch {
      setActionError('Failed to delete')
    } finally {
      setDeleteConfirm(null)
    }
  }

  const handleRename = async () => {
    if (!renameEntry || !renameValue.trim()) { setRenameEntry(null); return }
    setActionError('')
    try {
      const parts = renameEntry.path.split('/')
      parts.pop()
      const dest = parts.length > 0 ? `${parts.join('/')}/${renameValue.trim()}` : renameValue.trim()
      await moveFile(renameEntry.path, dest)
      refreshEntries()
    } catch {
      setActionError('Failed to rename')
    } finally {
      setRenameEntry(null)
    }
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

  const handleContextMenu = useCallback((e: React.MouseEvent, contextEntries: FileEntry[]) => {
    e.preventDefault()
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
          {/* Admin file management buttons */}
          {isAdmin && (
            <div className="flex items-center gap-1.5">
              <input ref={fileInputRef} type="file" className="hidden" onChange={handleUpload} />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadProgress !== null}
                className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-white bg-dark-800 hover:bg-dark-700 border border-dark-700 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                title="Upload file"
              >
                <Upload className="w-3.5 h-3.5" />
                {uploadProgress !== null ? `${uploadProgress}%` : 'Upload'}
              </button>
              <button
                onClick={() => setNewFolderName('')}
                className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-white bg-dark-800 hover:bg-dark-700 border border-dark-700 px-3 py-1.5 rounded-lg transition-colors"
                title="New folder"
              >
                <FolderPlus className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

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

      {/* Action error */}
      {actionError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2 rounded-lg text-sm mb-4 flex items-center justify-between">
          {actionError}
          <button onClick={() => setActionError('')} className="text-red-400 hover:text-red-300 ml-2">&times;</button>
        </div>
      )}

      {/* New folder inline input */}
      {newFolderName !== null && (
        <div className="flex items-center gap-2 mb-4">
          <FolderPlus className="w-4 h-4 text-yellow-400" />
          <input
            type="text"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setNewFolderName(null) }}
            placeholder="Folder name"
            className="bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-primary-500 w-64"
            autoFocus
          />
          <button onClick={handleCreateFolder} className="text-sm text-primary-400 hover:text-primary-300">Create</button>
          <button onClick={() => setNewFolderName(null)} className="text-sm text-gray-500 hover:text-gray-300">Cancel</button>
        </div>
      )}

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
          onManageSubtitles={() => {
            const videoFiles = contextMenu.entries.filter(e => !e.is_dir && isVideoFile(e.name))
            if (videoFiles.length === 1) setSubtitleManager(videoFiles[0])
          }}
          onDelete={() => setDeleteConfirm(contextMenu.entries)}
          onRename={() => {
            if (contextMenu.entries.length === 1) {
              setRenameEntry(contextMenu.entries[0])
              setRenameValue(contextMenu.entries[0].name)
            }
          }}
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

      {/* Subtitle Manager Dialog (single file) */}
      {subtitleManager && (
        <SubtitleManagerDialog
          file={subtitleManager}
          onClose={() => setSubtitleManager(null)}
          onTranslate={(subtitleId) => {
            // Open translate batch dialog with the selected file
            // The subtitle ID will be used by the translate dialog
            setBatchDialog({ mode: 'translate', files: [subtitleManager] })
            setSubtitleManager(null)
          }}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setDeleteConfirm(null)}>
          <div className="bg-dark-800 border border-dark-600 rounded-xl p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-white font-medium mb-2">Delete {deleteConfirm.length} item{deleteConfirm.length > 1 ? 's' : ''}?</h3>
            <p className="text-sm text-gray-400 mb-1">This cannot be undone.</p>
            <ul className="text-sm text-gray-500 mb-4 max-h-32 overflow-y-auto">
              {deleteConfirm.map(e => <li key={e.path} className="truncate">{e.name}</li>)}
            </ul>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteConfirm(null)} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
              <button onClick={handleDelete} className="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors">Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Dialog */}
      {renameEntry && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setRenameEntry(null)}>
          <div className="bg-dark-800 border border-dark-600 rounded-xl p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-white font-medium mb-3">Rename</h3>
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setRenameEntry(null) }}
              className="w-full bg-dark-900 border border-dark-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary-500 mb-4"
              autoFocus
              onFocus={(e) => {
                const dotIdx = e.target.value.lastIndexOf('.')
                if (dotIdx > 0) e.target.setSelectionRange(0, dotIdx)
              }}
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setRenameEntry(null)} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
              <button onClick={handleRename} className="px-4 py-2 text-sm bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors">Rename</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
