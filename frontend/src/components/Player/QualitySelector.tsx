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

  const handleSelect = (opt: typeof qualityPresets[0]) => {
    // If "original" is selected but audio is incompatible, switch to passthrough instead
    if (opt.value === 'original' && opt.can_original_video && !opt.can_original_audio) {
      const passthrough = qualityPresets.find((p) => p.value === 'passthrough')
      if (passthrough) {
        setQuality('passthrough')
        setOpen(false)
        return
      }
    }
    setQuality(opt.value)
    setOpen(false)
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="text-sm text-gray-300 hover:text-white transition-colors px-1"
        title="Quality"
      >
        {currentLabel}
        {codecBadge && quality !== 'original' && quality !== 'passthrough' && (
          <span className="ml-1 text-[10px] text-primary-400 font-semibold">{codecBadge}</span>
        )}
      </button>

      {open && (
        <div className="absolute bottom-8 right-0 bg-gray-900/95 border border-gray-700 rounded-lg py-1 min-w-[180px] z-50">
          {qualityPresets.map((opt) => {
            // Original option: show differently based on audio compatibility
            const isOriginal = opt.value === 'original'
            const isDisabled = isOriginal && !opt.can_original && !opt.can_original_video
            const isAudioIncompat = isOriginal && opt.can_original_video && !opt.can_original_audio

            return (
              <button
                key={opt.value}
                onClick={() => !isDisabled && handleSelect(opt)}
                className={`block w-full text-left px-3 py-1.5 text-sm transition-colors ${
                  isDisabled
                    ? 'text-gray-600 cursor-not-allowed opacity-40'
                    : quality === opt.value
                    ? 'text-primary-400 hover:bg-gray-700'
                    : isAudioIncompat
                    ? 'text-yellow-500/70 hover:bg-gray-700'
                    : 'text-gray-300 hover:bg-gray-700'
                }`}
                disabled={isDisabled}
                title={
                  isDisabled
                    ? 'Browser cannot play this format'
                    : isAudioIncompat
                    ? 'Audio codec not supported - will auto-convert audio'
                    : undefined
                }
              >
                <span>{opt.label}</span>
                {isDisabled && (
                  <span className="text-[10px] text-gray-600 ml-1">(unsupported)</span>
                )}
                {isAudioIncompat && (
                  <span className="text-[10px] text-yellow-500/70 ml-1">(audio convert)</span>
                )}
                {codecBadge && opt.value !== 'original' && opt.value !== 'passthrough' && (
                  <span className="text-[10px] text-primary-400 font-semibold ml-1">{codecBadge}</span>
                )}
                <span className="text-xs text-gray-500 ml-2">{opt.desc}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
