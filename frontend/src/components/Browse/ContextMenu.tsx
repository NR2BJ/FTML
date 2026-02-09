import { useEffect } from 'react'
import { Subtitles, Languages, Sparkles, ListVideo, Trash2, Pencil } from 'lucide-react'
import { type FileEntry } from '@/api/files'
import { isVideoFile } from '@/utils/format'
import { useAuthStore } from '@/stores/authStore'

interface ContextMenuProps {
  x: number
  y: number
  selectedEntries: FileEntry[]
  onClose: () => void
  onGenerateSubtitles: () => void
  onTranslateSubtitles: () => void
  onGenerateAndTranslate: () => void
  onManageSubtitles?: () => void
  onDelete?: () => void
  onRename?: () => void
}

export default function ContextMenu({
  x,
  y,
  selectedEntries,
  onClose,
  onGenerateSubtitles,
  onTranslateSubtitles,
  onGenerateAndTranslate,
  onManageSubtitles,
  onDelete,
  onRename,
}: ContextMenuProps) {
  const { user } = useAuthStore()
  const isAdmin = user?.role === 'admin'
  const canEdit = isAdmin || user?.role === 'user'
  const videoFiles = selectedEntries.filter(e => !e.is_dir && isVideoFile(e.name))
  const videoCount = videoFiles.length
  const totalCount = selectedEntries.length

  // Close on outside click or escape
  useEffect(() => {
    const handleClick = () => onClose()
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('click', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('click', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  if (totalCount === 0) return null

  // Adjust position to stay within viewport
  const menuWidth = 260
  const menuHeight = 280
  const adjustedX = Math.min(x, window.innerWidth - menuWidth - 8)
  const adjustedY = Math.min(y, window.innerHeight - menuHeight - 8)

  return (
    <div
      className="fixed z-50 bg-dark-800 border border-dark-600 rounded-lg shadow-2xl py-1 min-w-[240px]"
      style={{ left: adjustedX, top: adjustedY }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-1.5 text-xs text-gray-500 border-b border-dark-700">
        {totalCount} item{totalCount > 1 ? 's' : ''} selected
      </div>

      {/* Subtitle operations — only when video files are selected */}
      {videoCount > 0 && canEdit && (
        <>
          <button
            onClick={() => { onGenerateSubtitles(); onClose() }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-300 hover:bg-dark-700 hover:text-white transition-colors"
          >
            <Subtitles className="w-4 h-4 text-primary-400" />
            Generate Subtitles
          </button>

          {/* Batch translate: only when multiple videos (single video uses Manage Subtitles) */}
          {videoCount > 1 && (
            <button
              onClick={() => { onTranslateSubtitles(); onClose() }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-300 hover:bg-dark-700 hover:text-white transition-colors"
            >
              <Languages className="w-4 h-4 text-emerald-400" />
              Translate Subtitles
            </button>
          )}

          <div className="border-t border-dark-700 my-0.5" />

          <button
            onClick={() => { onGenerateAndTranslate(); onClose() }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-300 hover:bg-dark-700 hover:text-white transition-colors"
          >
            <Sparkles className="w-4 h-4 text-amber-400" />
            Generate & Translate
          </button>
        </>
      )}

      {/* Single video file: manage subtitles (also used for individual translate) */}
      {videoCount === 1 && onManageSubtitles && (
        <>
          <div className="border-t border-dark-700 my-0.5" />
          <button
            onClick={() => { onManageSubtitles(); onClose() }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-300 hover:bg-dark-700 hover:text-white transition-colors"
          >
            <ListVideo className="w-4 h-4 text-purple-400" />
            Manage Subtitles
          </button>
        </>
      )}

      {/* File management — admin only */}
      {isAdmin && (
        <>
          <div className="border-t border-dark-700 my-0.5" />

          {totalCount === 1 && onRename && (
            <button
              onClick={() => { onRename(); onClose() }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-300 hover:bg-dark-700 hover:text-white transition-colors"
            >
              <Pencil className="w-4 h-4 text-blue-400" />
              Rename
            </button>
          )}

          {onDelete && (
            <button
              onClick={() => { onDelete(); onClose() }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400 hover:bg-dark-700 hover:text-red-300 transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </button>
          )}
        </>
      )}
    </div>
  )
}
