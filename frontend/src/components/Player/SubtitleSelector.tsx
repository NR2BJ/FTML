import { useState, useRef, useEffect } from 'react'
import { Subtitles, Settings } from 'lucide-react'
import { usePlayerStore } from '@/stores/playerStore'
import SubtitleSettings from './SubtitleSettings'

export default function SubtitleSelector() {
  const [open, setOpen] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
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
    if (!open && !showSettings) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
        setShowSettings(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open, showSettings])

  if (subtitles.length === 0) return null

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => {
          setOpen(!open)
          setShowSettings(false)
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

      {open && !showSettings && (
        <div className="absolute bottom-8 right-0 bg-gray-900/95 border border-gray-700 rounded-lg py-1 min-w-[160px] z-50">
          {/* Off option */}
          <button
            onClick={() => {
              setActiveSubtitle(null)
              setOpen(false)
            }}
            className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-700 transition-colors ${
              activeSubtitle === null ? 'text-primary-400' : 'text-gray-300'
            }`}
          >
            Off
          </button>

          <div className="border-t border-gray-700 my-1" />

          {subtitles.map((sub) => (
            <button
              key={sub.id}
              onClick={() => {
                setActiveSubtitle(sub.id)
                setSubtitleVisible(true)
                setOpen(false)
              }}
              className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-700 transition-colors ${
                activeSubtitle === sub.id ? 'text-primary-400' : 'text-gray-300'
              }`}
            >
              <span>{sub.label}</span>
              <span className="text-xs text-gray-500 ml-2">
                {sub.type === 'embedded' ? 'Embedded' : sub.format.toUpperCase()}
              </span>
            </button>
          ))}

          <div className="border-t border-gray-700 my-1" />

          {/* Settings button */}
          <button
            onClick={() => {
              setOpen(false)
              setShowSettings(true)
            }}
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
          >
            <Settings className="w-3.5 h-3.5" />
            Settings
          </button>
        </div>
      )}

      {showSettings && (
        <SubtitleSettings onClose={() => setShowSettings(false)} />
      )}
    </div>
  )
}
