import { useEffect, useState, useRef, RefObject } from 'react'
import { usePlayerStore } from '@/stores/playerStore'
import { useSubtitleSettings } from '@/stores/subtitleSettingsStore'
import { getSubtitleUrl } from '@/api/subtitle'
import ASSDisplay from './ASSDisplay'
import { useToastStore } from '@/stores/toastStore'
import { useNativeSubtitleTrack } from './useNativeSubtitleTrack'

interface SubtitleCue {
  start: number
  end: number
  text: string
}

interface SubtitleDisplayProps {
  videoRef: RefObject<HTMLVideoElement | null>
  path: string
  getTime?: () => number | null
  renderWindow?: Window
}

import { parseVTT } from '@/utils/subtitles'
export default function SubtitleDisplay({ videoRef, path, getTime, renderWindow = window }: SubtitleDisplayProps) {
  const { activeSubtitle, secondarySubtitle, subtitleVisible, currentTime, subtitles } = usePlayerStore()
  const { syncOffset, fontSize, fontFamily, textColor, bgOpacity, plainText } = useSubtitleSettings()
  const [assFailed, setASSFailed] = useState(false)
  const format = subtitles.find(s => s.id === activeSubtitle)?.format.toLowerCase()
  const nativeASS = !plainText && !assFailed && (format === 'ass' || format === 'ssa')
  const [frameTime, setFrameTime] = useState<number | null>(currentTime)
  const clockRef = useRef(getTime)
  clockRef.current = getTime
  const hasClock = !!getTime
  useEffect(() => { setASSFailed(false) }, [activeSubtitle, path, subtitles, plainText, subtitleVisible])
  useEffect(() => {
    if (!hasClock || !subtitleVisible || nativeASS && !secondarySubtitle) return
    let frame = 0
    let previous: number | null | undefined
    const tick = () => {
      const time = clockRef.current?.() ?? null
      if (time !== previous && (time === null || previous == null || Math.abs(time-previous) >= 0.02)) {
        previous = time
        setFrameTime(time)
      }
      frame = renderWindow.requestAnimationFrame(tick)
    }
    tick()
    return () => renderWindow.cancelAnimationFrame(frame)
  }, [hasClock, subtitleVisible, nativeASS, secondarySubtitle, renderWindow])
  const [cues, setCues] = useState<SubtitleCue[]>([])
  const [secondaryCues, setSecondaryCues] = useState<SubtitleCue[]>([])

  // 같은 ID로 결과가 교체돼도 목록 갱신 또는 다시 켜기로 재조회한다.
  useEffect(() => {
    const controller = new AbortController()
    setCues([])
    if (!activeSubtitle || !subtitleVisible) {
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
  }, [activeSubtitle, path, subtitles, subtitleVisible])

  // Fetch and parse secondary subtitle
  useEffect(() => {
    const controller = new AbortController()
    setSecondaryCues([])
    if (!secondarySubtitle || !subtitleVisible) {
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
  }, [secondarySubtitle, path, subtitles, subtitleVisible])

  useNativeSubtitleTrack(videoRef,cues,secondaryCues,subtitleVisible,syncOffset,() =>
    clockRef.current ? clockRef.current() : usePlayerStore.getState().currentTime)

  if (!subtitleVisible) return null
  if (!activeSubtitle && !secondarySubtitle) return null

  const time = hasClock ? frameTime : currentTime
  const adjustedTime = time === null ? -1 : time + syncOffset
  const activePrimary = activeSubtitle && !nativeASS
    ? cues.filter((c) => adjustedTime >= c.start && adjustedTime < c.end)
    : []
  const activeSecondary = secondarySubtitle
    ? secondaryCues.filter((c) => adjustedTime >= c.start && adjustedTime < c.end)
    : []

  if (!nativeASS && activePrimary.length === 0 && activeSecondary.length === 0) return null

  const baseFontSize = 1.4 // rem
  const computedFontSize = baseFontSize * (fontSize / 100)
  const secondaryFontSize = computedFontSize * 0.85
  const displayFontSize = (size: number) => renderWindow === window
    ? `${size}rem`
    : `clamp(${size * 0.6}rem, ${size * 2.5}vw, ${size}rem)`

  return (
    <>
    {nativeASS && activeSubtitle && <ASSDisplay key={`${path}:${activeSubtitle}:${subtitleVisible}`} revision={subtitles} videoRef={videoRef} path={path} id={activeSubtitle} renderWindow={renderWindow}
      getTime={() => clockRef.current ? clockRef.current() : usePlayerStore.getState().currentTime} onFailure={() => {
        setASSFailed(true)
        useToastStore.getState().addToast({ type: 'warning', message: 'ASS 효과를 표시하지 못해 일반 자막으로 전환했습니다.' })
      }} />}
    <div className="subtitle-text-overlay absolute bottom-16 left-0 right-0 flex flex-col items-center pointer-events-none z-40 px-8">
      {/* Secondary subtitle (top, smaller, semi-transparent) */}
      {activeSecondary.map((cue, i) => (
        <div
          key={`sec-${i}`}
          className="px-2 py-0.5 rounded mb-1 text-center max-w-[80%]"
          style={{
            fontSize: displayFontSize(secondaryFontSize),
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
            fontSize: displayFontSize(computedFontSize),
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
    </>
  )
}
