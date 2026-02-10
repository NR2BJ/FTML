/**
 * Compute a session ID matching the Go backend's generateSessionID logic.
 * Go: fmt.Sprintf("%s|%s|%.0f|%s|%d", path, quality, startTime, codec, audioTrack) -> SHA-256[:8] -> hex
 */
export async function computeSessionID(
  path: string,
  quality: string,
  startTime: number,
  codec: string,
  audioTrack: number = 0
): Promise<string> {
  const key = `${path}|${quality}|${Math.floor(startTime)}|${codec}|${audioTrack}`
  const encoder = new TextEncoder()
  const data = encoder.encode(key)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = new Uint8Array(hashBuffer).slice(0, 8)
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
