import { useState, useRef, useEffect } from 'react'
import { Subtitles, Settings, Wand2, Languages } from 'lucide-react'
import { usePlayerStore } from '@/stores/playerStore'
import SubtitleSettings from './SubtitleSettings'
import SubtitleGenerate from './SubtitleGenerate'
import SubtitleTranslate from './SubtitleTranslate'
import type { SubtitleEntry } from '@/api/subtitle'

type Panel = 'menu' | 'settings' | 'generate' | 'translate'

export default function SubtitleSelector() {
  const [panel, setPanel] = useState<Panel | null>(null)
  const [translateSource, setTranslateSource] = useState<SubtitleEntry | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const {
    subtitles,
    activeSubtitle,
    subtitleVisible,
    setActiveSubtitle,
    setSubtitleVisible,
  } = usePlayerStore()

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
        <div className="absolute bottom-8 right-0 bg-gray-900/95 border border-gray-700 rounded-lg py-1 min-w-[200px] z-50">
          {subtitles.length === 0 ? (
            <div className="px-3 py-1.5 text-sm text-gray-500">
              No subtitles available
            </div>
          ) : (
            <>
              {/* Off option */}
              <button
                onClick={() => {
                  setActiveSubtitle(null)
                  setPanel(null)
                }}
                className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-700 transition-colors ${
                  activeSubtitle === null ? 'text-primary-400' : 'text-gray-300'
                }`}
              >
                Off
              </button>

              <div className="border-t border-gray-700 my-1" />

              {subtitles.map((sub) => (
                <div
                  key={sub.id}
                  className="flex items-center hover:bg-gray-700 transition-colors group"
                >
                  <button
                    onClick={() => {
                      setActiveSubtitle(sub.id)
                      setSubtitleVisible(true)
                      setPanel(null)
                    }}
                    className={`flex-1 text-left px-3 py-1.5 text-sm ${
                      activeSubtitle === sub.id ? 'text-primary-400' : 'text-gray-300'
                    }`}
                  >
                    <span>{sub.label}</span>
                    <span className="text-xs text-gray-500 ml-2">
                      {sub.type === 'embedded' ? 'Embedded' : sub.type === 'generated' ? 'AI' : sub.format.toUpperCase()}
                    </span>
                  </button>
                  {/* Translate button for each subtitle */}
                  <button
                    onClick={() => openTranslate(sub)}
                    className="p-1 mr-1 text-gray-500 hover:text-primary-400 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Translate this subtitle"
                  >
                    <Languages className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </>
          )}

          <div className="border-t border-gray-700 my-1" />

          {/* Generate button */}
          <button
            onClick={() => setPanel('generate')}
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
          >
            <Wand2 className="w-3.5 h-3.5" />
            Generate (AI)
          </button>

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
