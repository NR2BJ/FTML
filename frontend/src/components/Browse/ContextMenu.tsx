import { useEffect } from 'react'
import { Subtitles, Languages, Sparkles, ListVideo } from 'lucide-react'
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
}: ContextMenuProps) {
  const { user } = useAuthStore()
  const canEdit = user?.role === 'admin' || user?.role === 'editor'
  const videoFiles = selectedEntries.filter(e => !e.is_dir && isVideoFile(e.name))
  const count = videoFiles.length

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

  if (count === 0) return null

  // Adjust position to stay within viewport
  const menuWidth = 260
  const menuHeight = count === 1 ? 220 : 160
  const adjustedX = Math.min(x, window.innerWidth - menuWidth - 8)
  const adjustedY = Math.min(y, window.innerHeight - menuHeight - 8)

  return (
    <div
      className="fixed z-50 bg-dark-800 border border-dark-600 rounded-lg shadow-2xl py-1 min-w-[240px]"
      style={{ left: adjustedX, top: adjustedY }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-1.5 text-xs text-gray-500 border-b border-dark-700">
        {count} video file{count > 1 ? 's' : ''} selected
      </div>

      {canEdit && (
        <>
          <button
            onClick={() => { onGenerateSubtitles(); onClose() }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-300 hover:bg-dark-700 hover:text-white transition-colors"
          >
            <Subtitles className="w-4 h-4 text-primary-400" />
            Generate Subtitles
          </button>

          <button
            onClick={() => { onTranslateSubtitles(); onClose() }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-300 hover:bg-dark-700 hover:text-white transition-colors"
          >
            <Languages className="w-4 h-4 text-emerald-400" />
            Translate Subtitles
          </button>

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

      {/* Single file: manage subtitles (view, delete, translate individual) */}
      {count === 1 && onManageSubtitles && (
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
    </div>
  )
}
