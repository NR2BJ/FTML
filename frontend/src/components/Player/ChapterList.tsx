import { useState } from 'react'
import { List, X } from 'lucide-react'
import { usePlayerStore } from '@/stores/playerStore'
import { formatDuration } from '@/utils/format'

interface ChapterListProps {
  onSeek: (time: number) => void
}

export default function ChapterList({ onSeek }: ChapterListProps) {
  const { chapters, currentTime } = usePlayerStore()
  const [open, setOpen] = useState(false)

  if (chapters.length === 0) return null

  // Find current chapter
  const currentChapter = chapters.findIndex(
    (ch) => currentTime >= ch.start_time && currentTime < ch.end_time
  )

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`transition-colors px-1 ${
          open ? 'text-primary-400 hover:text-primary-300' : 'text-gray-300 hover:text-white'
        }`}
        title="Chapters"
      >
        <List className="w-4.5 h-4.5" />
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-72 bg-dark-800 border border-dark-600 rounded-lg shadow-xl z-50 max-h-80 overflow-auto">
          <div className="flex items-center justify-between px-3 py-2 border-b border-dark-700">
            <span className="text-sm font-medium text-white">Chapters</span>
            <button onClick={() => setOpen(false)} className="text-gray-500 hover:text-gray-300">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {chapters.map((ch, i) => (
            <button
              key={i}
              onClick={() => {
                onSeek(ch.start_time)
                setOpen(false)
              }}
              className={`w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-dark-700 transition-colors ${
                i === currentChapter ? 'bg-primary-900/30 border-l-2 border-l-primary-500' : ''
              }`}
            >
              <span className="text-xs text-gray-500 tabular-nums shrink-0 w-12">
                {formatDuration(ch.start_time)}
              </span>
              <span className={`text-sm truncate ${i === currentChapter ? 'text-primary-400' : 'text-gray-300'}`}>
                {ch.title || `Chapter ${i + 1}`}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
