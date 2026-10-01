import { useEffect, useState, RefObject } from 'react'
import { usePlayerStore } from '@/stores/playerStore'
import { useSubtitleSettings } from '@/stores/subtitleSettingsStore'
import { getSubtitleUrl } from '@/api/subtitle'

interface SubtitleCue {
  start: number
  end: number
  text: string
}

interface SubtitleDisplayProps {
  videoRef: RefObject<HTMLVideoElement | null>
  path: string
}

import { parseVTT } from '@/utils/subtitles'
export default function SubtitleDisplay({ videoRef, path }: SubtitleDisplayProps) {
  const { activeSubtitle, secondarySubtitle, subtitleVisible, currentTime } = usePlayerStore()
  const { syncOffset, fontSize, fontFamily, textColor, bgOpacity } = useSubtitleSettings()
  const [cues, setCues] = useState<SubtitleCue[]>([])
  const [secondaryCues, setSecondaryCues] = useState<SubtitleCue[]>([])

  // Fetch and parse primary subtitle
  useEffect(() => {
    const controller = new AbortController()
    setCues([])
    if (!activeSubtitle) {
      setCues([])
      return
    }

    const url = getSubtitleUrl(path, activeSubtitle)
    fetch(url, { signal: controller.signal, cache: 'no-cache' })
      .then((res) => { if (!res.ok) throw new Error('자막 요청 실패'); return res.text() })
      .then((text) => {
        if (controller.signal.aborted) return
        setCues(parseVTT(text))
      })
      .catch(() => { if (!controller.signal.aborted) setCues([]) })
    return () => controller.abort()
  }, [activeSubtitle, path])

  // Fetch and parse secondary subtitle
  useEffect(() => {
    const controller = new AbortController()
    setSecondaryCues([])
    if (!secondarySubtitle) {
      setSecondaryCues([])
      return
    }

    const url = getSubtitleUrl(path, secondarySubtitle)
    fetch(url, { signal: controller.signal, cache: 'no-cache' })
      .then((res) => { if (!res.ok) throw new Error('자막 요청 실패'); return res.text() })
      .then((text) => {
        if (controller.signal.aborted) return
        setSecondaryCues(parseVTT(text))
      })
      .catch(() => { if (!controller.signal.aborted) setSecondaryCues([]) })
    return () => controller.abort()
  }, [secondarySubtitle, path])

  if (!subtitleVisible) return null
  if (!activeSubtitle && !secondarySubtitle) return null

  const adjustedTime = currentTime + syncOffset
  const activePrimary = activeSubtitle
    ? cues.filter((c) => adjustedTime >= c.start && adjustedTime < c.end)
    : []
  const activeSecondary = secondarySubtitle
    ? secondaryCues.filter((c) => adjustedTime >= c.start && adjustedTime < c.end)
    : []

  if (activePrimary.length === 0 && activeSecondary.length === 0) return null

  const baseFontSize = 1.4 // rem
  const computedFontSize = baseFontSize * (fontSize / 100)
  const secondaryFontSize = computedFontSize * 0.85

  return (
    <div className="absolute bottom-16 left-0 right-0 flex flex-col items-center pointer-events-none z-40 px-8">
      {/* Secondary subtitle (top, smaller, semi-transparent) */}
      {activeSecondary.map((cue, i) => (
        <div
          key={`sec-${i}`}
          className="px-2 py-0.5 rounded mb-1 text-center max-w-[80%]"
          style={{
            fontSize: `${secondaryFontSize}rem`,
            fontFamily,
            color: 'rgba(200,200,200,0.9)',
            backgroundColor: `rgba(0, 0, 0, ${bgOpacity * 0.6})`,
            whiteSpace: 'pre-wrap',
            textShadow: '1px 1px 2px rgba(0,0,0,0.8)',
          }}
        >
          {cue.text}
        </div>
      ))}
      {/* Primary subtitle (bottom, normal) */}
      {activePrimary.map((cue, i) => (
        <div
          key={`pri-${i}`}
          className="px-2 py-1 rounded mb-1 text-center max-w-[80%]"
          style={{
            fontSize: `${computedFontSize}rem`,
            fontFamily,
            color: textColor,
            backgroundColor: `rgba(0, 0, 0, ${bgOpacity})`,
            whiteSpace: 'pre-wrap',
            textShadow: '1px 1px 2px rgba(0,0,0,0.8)',
          }}
        >
          {cue.text}
        </div>
      ))}
    </div>
  )
}
