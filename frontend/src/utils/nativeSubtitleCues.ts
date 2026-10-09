export interface PlainCue {
  start: number
  end: number
  text: string
}

export function nativeSubtitleCues(
  cues: PlainCue[],
  origin: number,
  syncOffset: number,
) {
  return cues.flatMap((cue) => {
    const start = Math.max(0, cue.start - origin - syncOffset)
    const end = cue.end - origin - syncOffset
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      return []
    // parseVTT가 해제한 문자 참조를 다시 보호해 VTTCue가 태그로 해석하지 않게 한다.
    const text = cue.text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    return [{ start, end, text }]
  })
}
