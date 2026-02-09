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

function parseVTT(vttText: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const blocks = vttText.split(/\n\n+/)

  for (const block of blocks) {
    const lines = block.trim().split('\n')
    let timestampLine = -1

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) {
        timestampLine = i
        break
      }
    }

    if (timestampLine === -1) continue

    const match = lines[timestampLine].match(
      /(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{3})/
    )
    if (!match) continue

    const startH = match[1] ? parseInt(match[1]) : 0
    const startM = parseInt(match[2])
    const startS = parseInt(match[3])
    const startMs = parseInt(match[4])
    const endH = match[5] ? parseInt(match[5]) : 0
    const endM = parseInt(match[6])
    const endS = parseInt(match[7])
    const endMs = parseInt(match[8])

    const start = startH * 3600 + startM * 60 + startS + startMs / 1000
    const end = endH * 3600 + endM * 60 + endS + endMs / 1000

    const textLines = lines.slice(timestampLine + 1)
    // Strip basic HTML tags but keep line breaks
    const text = textLines
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim()

    if (text) {
      cues.push({ start, end, text })
    }
  }

  return cues
}

export default function SubtitleDisplay({ videoRef, path }: SubtitleDisplayProps) {
  const { activeSubtitle, secondarySubtitle, subtitleVisible, currentTime } = usePlayerStore()
  const { syncOffset, fontSize, fontFamily, textColor, bgOpacity } = useSubtitleSettings()
  const [cues, setCues] = useState<SubtitleCue[]>([])
  const [secondaryCues, setSecondaryCues] = useState<SubtitleCue[]>([])

  // Fetch and parse primary subtitle
  useEffect(() => {
    if (!activeSubtitle) {
      setCues([])
      return
    }

    const url = getSubtitleUrl(path, activeSubtitle)
    fetch(url)
      .then((res) => res.text())
      .then((text) => {
        setCues(parseVTT(text))
      })
      .catch(() => setCues([]))
  }, [activeSubtitle, path])

  // Fetch and parse secondary subtitle
  useEffect(() => {
    if (!secondarySubtitle) {
      setSecondaryCues([])
      return
    }

    const url = getSubtitleUrl(path, secondarySubtitle)
    fetch(url)
      .then((res) => res.text())
      .then((text) => {
        setSecondaryCues(parseVTT(text))
      })
      .catch(() => setSecondaryCues([]))
  }, [secondarySubtitle, path])

  if (!subtitleVisible) return null
  if (!activeSubtitle && !secondarySubtitle) return null

  const adjustedTime = currentTime + syncOffset
  const activePrimary = activeSubtitle
    ? cues.filter((c) => adjustedTime >= c.start && adjustedTime <= c.end)
    : []
  const activeSecondary = secondarySubtitle
    ? secondaryCues.filter((c) => adjustedTime >= c.start && adjustedTime <= c.end)
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
