import { useState, useRef, useEffect } from 'react'
import { usePlayerStore } from '@/stores/playerStore'

const qualityOptions = [
  { value: 'low', label: '720p', desc: '8 Mbps' },
  { value: 'medium', label: '1080p', desc: '15 Mbps' },
  { value: 'high', label: '1080p+', desc: '25 Mbps' },
  { value: 'original', label: 'Original', desc: 'Direct play' },
]

export default function QualitySelector() {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const { quality, setQuality } = usePlayerStore()

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

  const currentLabel = qualityOptions.find((q) => q.value === quality)?.label || 'Auto'

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="text-sm text-gray-300 hover:text-white transition-colors px-1"
        title="Quality"
      >
        {currentLabel}
      </button>

      {open && (
        <div className="absolute bottom-8 right-0 bg-gray-900/95 border border-gray-700 rounded-lg py-1 min-w-[140px] z-50">
          {qualityOptions.map((opt) => (
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
              <span className="text-xs text-gray-500 ml-2">{opt.desc}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
