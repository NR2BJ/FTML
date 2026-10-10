import { useEffect } from 'react'
import { Subtitles } from 'lucide-react'
import type { FileEntry } from '@/api/files'
import { isVideoFile } from '@/utils/format'

export default function ContextMenu({ x, y, selectedEntries, onClose, onSubtitles }: {
  x: number
  y: number
  selectedEntries: FileEntry[]
  onClose: () => void
  onSubtitles: () => void
}) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('click', onClose)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('click', onClose)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])
  const count = selectedEntries.filter(e => !e.is_dir && isVideoFile(e.name)).length
  if (!count) return null
  return <div role="menu" aria-label="영상 작업"
    className="fixed z-50 min-w-[200px] rounded-lg border border-dark-600 bg-dark-800 py-1 shadow-2xl"
    style={{ left: Math.max(8, Math.min(x, window.innerWidth - 220)), top: Math.max(8, Math.min(y, window.innerHeight - 96)) }}
    onClick={event => event.stopPropagation()}>
    <p className="border-b border-dark-700 px-3 py-1.5 text-xs text-gray-500">영상 {count}개 선택</p>
    <button role="menuitem" onClick={() => { onSubtitles(); onClose() }}
      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-dark-700">
      <Subtitles size={16} className="text-primary-400" />자막 패널
    </button>
  </div>
}
