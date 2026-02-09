import { useState, useEffect } from 'react'
import { X, Trash2, Languages, Loader2, Subtitles } from 'lucide-react'
import { type FileEntry } from '@/api/files'
import { listSubtitles, deleteSubtitle, type SubtitleEntry } from '@/api/subtitle'
import { useAuthStore } from '@/stores/authStore'

interface SubtitleManagerDialogProps {
  file: FileEntry
  onClose: () => void
  onTranslate: (subtitleId: string) => void
}

export default function SubtitleManagerDialog({ file, onClose, onTranslate }: SubtitleManagerDialogProps) {
  const [subtitles, setSubtitles] = useState<SubtitleEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)
  const { user } = useAuthStore()
  const isAdmin = user?.role === 'admin'
  const canEdit = isAdmin || user?.role === 'user'

  const fetchSubtitles = () => {
    setLoading(true)
    listSubtitles(file.path)
      .then(({ data }) => setSubtitles(data || []))
      .catch(() => setSubtitles([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchSubtitles()
  }, [file.path])

  const handleDelete = async (sub: SubtitleEntry) => {
    if (deleting) return
    setDeleting(sub.id)
    try {
      await deleteSubtitle(file.path, sub.id)
      fetchSubtitles()
    } catch {
      // ignore
    } finally {
      setDeleting(null)
    }
  }

  const handleTranslate = (sub: SubtitleEntry) => {
    onTranslate(sub.id)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-dark-800 border border-dark-600 rounded-xl shadow-2xl w-[480px] max-h-[70vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-dark-700">
          <div className="flex items-center gap-2.5 min-w-0">
            <Subtitles className="w-4.5 h-4.5 text-primary-400 shrink-0" />
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-white">Subtitle Manager</h3>
              <p className="text-xs text-gray-500 truncate">{file.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
            <X className="w-4.5 h-4.5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 text-gray-500 animate-spin" />
            </div>
          ) : subtitles.length === 0 ? (
            <div className="text-center py-8 text-gray-500 text-sm">
              No subtitles found for this file
            </div>
          ) : (
            <div className="space-y-1">
              {subtitles.map((sub) => {
                const isGenerated = sub.type === 'generated'
                const typeColors: Record<string, string> = {
                  embedded: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
                  external: 'bg-green-500/10 text-green-400 border-green-500/20',
                  generated: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
                }

                return (
                  <div
                    key={sub.id}
                    className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-dark-900/50 hover:bg-dark-700/50 transition-colors group"
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${typeColors[sub.type] || ''}`}>
                        {sub.type}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm text-gray-300 truncate">{sub.label}</p>
                        <p className="text-xs text-gray-600">
                          {sub.language && <span>{sub.language}</span>}
                          {sub.format && <span> · {sub.format}</span>}
                        </p>
                      </div>
                    </div>

                    {canEdit && (
                      <div className="flex items-center gap-1 shrink-0">
                        {/* Translate button */}
                        <button
                          onClick={() => handleTranslate(sub)}
                          title="Translate this subtitle"
                          className="p-1.5 rounded text-gray-600 hover:text-emerald-400 hover:bg-dark-600 transition-colors opacity-0 group-hover:opacity-100"
                        >
                          <Languages className="w-3.5 h-3.5" />
                        </button>

                        {/* Delete button (generated only, admin only) */}
                        {isAdmin && isGenerated && (
                          <button
                            onClick={() => handleDelete(sub)}
                            disabled={deleting === sub.id}
                            title="Delete this subtitle"
                            className="p-1.5 rounded text-gray-600 hover:text-red-400 hover:bg-dark-600 transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-50"
                          >
                            {deleting === sub.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="w-3.5 h-3.5" />
                            )}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-dark-700 text-xs text-gray-600">
          {subtitles.length} subtitle{subtitles.length !== 1 ? 's' : ''}
          {isAdmin && ' · Only generated subtitles can be deleted'}
        </div>
      </div>
    </div>
  )
}
