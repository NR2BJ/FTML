import { useState, useRef, useEffect } from 'react'
import { Subtitles, Settings, Wand2, Languages, Trash2, Upload, Download } from 'lucide-react'
import { usePlayerStore } from '@/stores/playerStore'
import { useToastStore } from '@/stores/toastStore'
import { useAuthStore } from '@/stores/authStore'
import { deleteSubtitle, listSubtitles, uploadSubtitle, convertSubtitle } from '@/api/subtitle'
import SubtitleSettings from './SubtitleSettings'
import SubtitleGenerate from './SubtitleGenerate'
import SubtitleTranslate from './SubtitleTranslate'
import type { SubtitleEntry } from '@/api/subtitle'

type Panel = 'menu' | 'settings' | 'generate' | 'translate'

export default function SubtitleSelector() {
  const { user } = useAuthStore()
  const isAdmin = user?.role === 'admin'
  const canEdit = isAdmin || user?.role === 'user'
  const [panel, setPanel] = useState<Panel | null>(null)
  const [translateSource, setTranslateSource] = useState<SubtitleEntry | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [converting, setConverting] = useState(false)
  const addToast = useToastStore((s) => s.addToast)
  const menuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const {
    subtitles,
    activeSubtitle,
    secondarySubtitle,
    subtitleVisible,
    currentFile,
    setActiveSubtitle,
    setSecondarySubtitle,
    setSubtitleVisible,
    setSubtitles,
  } = usePlayerStore()
  const [subMode, setSubMode] = useState<'primary' | 'secondary'>('primary')

  // Close menu on outside click
  useEffect(() => {
    if (!panel) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setPanel(null)
        setTranslateSource(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [panel])

  const openTranslate = (sub: SubtitleEntry) => {
    setTranslateSource(sub)
    setPanel('translate')
  }

  const handleDelete = async (sub: SubtitleEntry) => {
    if (!currentFile) return
    setDeleting(sub.id)
    try {
      await deleteSubtitle(currentFile, sub.id)
      // If the deleted subtitle was active, clear it
      if (activeSubtitle === sub.id) {
        setActiveSubtitle(null)
      }
      // Refresh the subtitle list
      const { data } = await listSubtitles(currentFile)
      setSubtitles(data || [])
    } catch {
      // Silent fail
    } finally {
      setDeleting(null)
    }
  }

  const handleConvert = async (sub: SubtitleEntry, targetFormat: string) => {
    if (!currentFile) return
    setConverting(true)
    try {
      const { data } = await convertSubtitle(currentFile, sub.id, targetFormat)
      const blob = new Blob([data as BlobPart])
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${sub.label}.${targetFormat}`
      a.click()
      URL.revokeObjectURL(url)
      addToast({ type: 'success', message: `Converted to ${targetFormat.toUpperCase()}` })
    } catch {
      addToast({ type: 'error', message: 'Conversion failed' })
    } finally {
      setConverting(false)
    }
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !currentFile) return
    setUploading(true)
    try {
      await uploadSubtitle(currentFile, file)
      const { data } = await listSubtitles(currentFile)
      setSubtitles(data || [])
    } catch {
      // Silent fail
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => {
          setPanel(panel === 'menu' ? null : 'menu')
          setTranslateSource(null)
        }}
        className={`text-sm transition-colors px-1 ${
          activeSubtitle && subtitleVisible
            ? 'text-primary-400 hover:text-primary-300'
            : 'text-gray-300 hover:text-white'
        }`}
        title="Subtitles"
      >
        <Subtitles className="w-5 h-5" />
      </button>

      {panel === 'menu' && (
        <div className="absolute bottom-8 right-0 bg-gray-900/95 border border-gray-700 rounded-lg py-1 min-w-[240px] z-50">
          {/* Primary / Secondary tabs */}
          {subtitles.length > 0 && (
            <div className="flex border-b border-gray-700 mx-1 mb-1">
              <button
                onClick={() => setSubMode('primary')}
                className={`flex-1 text-xs py-1.5 transition-colors ${
                  subMode === 'primary' ? 'text-primary-400 border-b-2 border-primary-400' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                Primary
              </button>
              <button
                onClick={() => setSubMode('secondary')}
                className={`flex-1 text-xs py-1.5 transition-colors ${
                  subMode === 'secondary' ? 'text-primary-400 border-b-2 border-primary-400' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                Secondary
              </button>
            </div>
          )}

          {subtitles.length === 0 ? (
            <div className="px-3 py-1.5 text-sm text-gray-500">
              No subtitles available
            </div>
          ) : (
            <>
              {/* Off option */}
              <button
                onClick={() => {
                  if (subMode === 'primary') {
                    setActiveSubtitle(null)
                    usePlayerStore.getState().setSubtitleEnabled(false)
                  } else {
                    setSecondarySubtitle(null)
                  }
                  setPanel(null)
                }}
                className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-700 transition-colors ${
                  (subMode === 'primary' ? activeSubtitle : secondarySubtitle) === null ? 'text-primary-400' : 'text-gray-300'
                }`}
              >
                Off
              </button>

              <div className="border-t border-gray-700 my-1" />

              {subtitles.map((sub) => {
                const isActive = subMode === 'primary' ? activeSubtitle === sub.id : secondarySubtitle === sub.id
                return (
                  <div
                    key={sub.id}
                    className="flex items-center hover:bg-gray-700 transition-colors group"
                  >
                    <button
                      onClick={() => {
                        if (subMode === 'primary') {
                          setActiveSubtitle(sub.id)
                          usePlayerStore.getState().setSubtitleEnabled(true)
                          if (sub.language) {
                            usePlayerStore.getState().setPreferredSubLang(sub.language)
                          }
                        } else {
                          setSecondarySubtitle(sub.id)
                        }
                        setSubtitleVisible(true)
                        setPanel(null)
                      }}
                      className={`flex-1 text-left px-3 py-1.5 text-sm ${
                        isActive ? 'text-primary-400' : 'text-gray-300'
                      }`}
                    >
                      <span>{sub.label}</span>
                      <span className="text-xs text-gray-500 ml-2">
                        {sub.type === 'embedded' ? 'Embedded' : sub.type === 'generated' ? 'AI' : sub.format.toUpperCase()}
                      </span>
                    </button>
                    {/* Action buttons (only for primary mode) */}
                    {subMode === 'primary' && (
                      <div className={`flex items-center transition-opacity ${
                        sub.type === 'generated'
                          ? 'opacity-60 group-hover:opacity-100'
                          : 'opacity-0 group-hover:opacity-100'
                      }`}>
                        {/* Download/convert dropdown */}
                        {canEdit && sub.type !== 'embedded' && (
                          <div className="relative group/dl">
                            <button
                              className="p-1 text-gray-500 hover:text-green-400"
                              title="Download / Convert"
                              disabled={converting}
                            >
                              <Download className="w-3.5 h-3.5" />
                            </button>
                            <div className="hidden group-hover/dl:block absolute bottom-full right-0 mb-1 bg-dark-800 border border-dark-600 rounded-lg shadow-xl z-50 py-1 min-w-[80px]">
                              {['srt', 'vtt', 'ass'].filter(f => f !== sub.format).map(fmt => (
                                <button
                                  key={fmt}
                                  onClick={() => handleConvert(sub, fmt)}
                                  className="block w-full text-left px-3 py-1 text-xs text-gray-300 hover:bg-dark-700 uppercase"
                                >
                                  {fmt}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        {canEdit && (
                          <button
                            onClick={() => openTranslate(sub)}
                            className="p-1 text-gray-500 hover:text-primary-400"
                            title="Translate this subtitle"
                          >
                            <Languages className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {isAdmin && sub.type === 'generated' && (
                          <button
                            onClick={() => handleDelete(sub)}
                            disabled={deleting === sub.id}
                            className="p-1 mr-1 text-gray-500 hover:text-red-400 disabled:opacity-50"
                            title="Delete this subtitle"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}

          <div className="border-t border-gray-700 my-1" />

          {/* Generate button — editor/admin only */}
          {canEdit && (
            <button
              onClick={() => setPanel('generate')}
              className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
            >
              <Wand2 className="w-3.5 h-3.5" />
              Generate (AI)
            </button>
          )}

          {/* Upload subtitle — editor/admin only */}
          {canEdit && (
            <>
              <input ref={fileInputRef} type="file" accept=".srt,.vtt,.ass,.ssa" className="hidden" onChange={handleUpload} />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 transition-colors disabled:opacity-50"
              >
                <Upload className="w-3.5 h-3.5" />
                {uploading ? 'Uploading...' : 'Upload Subtitle'}
              </button>
            </>
          )}

          {/* Settings button */}
          <button
            onClick={() => setPanel('settings')}
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
          >
            <Settings className="w-3.5 h-3.5" />
            Settings
          </button>
        </div>
      )}

      {panel === 'settings' && (
        <SubtitleSettings onClose={() => setPanel(null)} />
      )}

      {panel === 'generate' && (
        <SubtitleGenerate onClose={() => setPanel(null)} />
      )}

      {panel === 'translate' && translateSource && (
        <SubtitleTranslate
          sourceSubtitle={translateSource}
          onClose={() => { setPanel(null); setTranslateSource(null) }}
        />
      )}
    </div>
  )
}
