import { formatDuration } from './format'

/**
 * Capture a screenshot from a video element and trigger a PNG download.
 * Returns true on success, false on failure.
 */
export function captureScreenshot(video: HTMLVideoElement, filePath: string, time: number): boolean {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/png')
    const a = document.createElement('a')
    const fileName = filePath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'screenshot'
    a.href = dataUrl
    a.download = `${fileName}_${formatDuration(time).replace(/:/g, '-')}.png`
    a.click()
    return true
  } catch {
    return false
  }
}
