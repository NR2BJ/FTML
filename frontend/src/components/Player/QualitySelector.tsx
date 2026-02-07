import { useState, useRef, useEffect } from 'react'
import { usePlayerStore } from '@/stores/playerStore'

export default function QualitySelector() {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const { quality, qualityPresets, setQuality, negotiatedCodec } = usePlayerStore()

  // Close menu on outside click
  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const currentPreset = qualityPresets.find((q) => q.value === quality)
  const currentLabel = currentPreset?.label || quality
  const codecBadge = negotiatedCodec ? negotiatedCodec.toUpperCase() : null

  // Don't render if no presets loaded yet
  if (qualityPresets.length === 0) return null

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="text-sm text-gray-300 hover:text-white transition-colors px-1"
        title="Quality"
      >
        {currentLabel}
        {codecBadge && quality !== 'original' && (
          <span className="ml-1 text-[10px] text-primary-400 font-semibold">{codecBadge}</span>
        )}
      </button>

      {open && (
        <div className="absolute bottom-8 right-0 bg-gray-900/95 border border-gray-700 rounded-lg py-1 min-w-[160px] z-50">
          {qualityPresets.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                setQuality(opt.value)
                setOpen(false)
              }}
              className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-700 transition-colors ${
                quality === opt.value ? 'text-primary-400' : 'text-gray-300'
              }`}
            >
              <span>{opt.label}</span>
              {codecBadge && opt.value !== 'original' && (
                <span className="text-[10px] text-primary-400 font-semibold ml-1">{codecBadge}</span>
              )}
              <span className="text-xs text-gray-500 ml-2">{opt.desc}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
