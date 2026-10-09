import { useEffect, useRef, type RefObject } from 'react'
import { nativeSubtitleCues, type PlainCue } from '@/utils/nativeSubtitleCues'

// src 없는 <track>은 Chromium이 나중에 비울 수 있다. 직접 만든 트랙은 제거 API가 없어 재사용한다.
const tracks = new WeakMap<HTMLVideoElement, TextTrack>()

export function useNativeSubtitleTrack(
  videoRef: RefObject<HTMLVideoElement | null>,
  primary: PlainCue[],
  secondary: PlainCue[],
  enabled: boolean,
  syncOffset: number,
  getTime: () => number | null,
) {
  const clock = useRef(getTime)
  clock.current = getTime
  useEffect(() => {
    const video = videoRef.current
    if (!video || !enabled || typeof VTTCue === 'undefined') return
    let track = tracks.get(video)
    if (!track) {
      track = video.addTextTrack('subtitles', 'FTML 선택 자막')
      tracks.set(video, track)
    }
    video.classList.add('ftml-native-captions')
    track.mode = 'hidden'
    let previous: number | null | undefined
    const update = () => {
      const absolute = clock.current()
      const origin = absolute === null ? null : absolute - video.currentTime
      if (
        (origin !== null &&
          previous != null &&
          Math.abs(origin - previous) < 0.001) ||
        (origin === null && previous === null)
      )
        return
      previous = origin
      track.mode = 'hidden'
      for (const cue of Array.from(track.cues || [])) track.removeCue(cue)
      if (origin === null) return
      for (const [cues, line] of [
        [secondary, -2],
        [primary, -1],
      ] as const) {
        for (const cue of nativeSubtitleCues(cues, origin, syncOffset)) {
          const native = new VTTCue(cue.start, cue.end, cue.text)
          native.line = line
          track.addCue(native)
        }
      }
      track.mode = 'showing'
    }
    update()
    const events = [
      'timeupdate',
      'loadedmetadata',
      'emptied',
      'seeking',
      'seeked',
    ]
    events.forEach((event) => video.addEventListener(event, update))
    const timer = window.setInterval(update, 250)
    return () => {
      window.clearInterval(timer)
      events.forEach((event) => video.removeEventListener(event, update))
      track.mode = 'hidden'
      for (const cue of Array.from(track.cues || [])) track.removeCue(cue)
      track.mode = 'disabled'
      video.classList.remove('ftml-native-captions')
    }
  }, [videoRef, primary, secondary, enabled, syncOffset])
}
