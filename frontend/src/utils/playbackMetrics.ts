export interface PlaybackSample {
  wallTime: number
  mediaTime: number
  totalFrames: number
  droppedFrames: number
  playbackRate: number
}

export function playbackDelta(previous: PlaybackSample | null, current: PlaybackSample) {
  if (!previous) return null
  const seconds = (current.wallTime - previous.wallTime) / 1000
  const mediaSeconds = current.mediaTime - previous.mediaTime
  const totalFrames = current.totalFrames - previous.totalFrames
  const droppedFrames = current.droppedFrames - previous.droppedFrames
  // 탐색, 소스 교체, 배속 변경, 절전 구간을 정상 재생 구간으로 계산하지 않는다.
  if (![seconds, mediaSeconds, totalFrames, droppedFrames, current.playbackRate].every(Number.isFinite) ||
      seconds <= 0 || seconds > 5 || mediaSeconds < 0 || totalFrames < 0 || droppedFrames < 0 ||
      previous.playbackRate !== current.playbackRate ||
      mediaSeconds > seconds * current.playbackRate + 0.5) return null
  return {
    displayedFPS: Math.max(0, totalFrames - droppedFrames) / seconds,
    mediaSpeed: mediaSeconds / seconds,
    droppedFrames,
  }
}
