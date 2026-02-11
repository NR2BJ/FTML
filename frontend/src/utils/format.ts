const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.mpg', '.mpeg',
])

export function isVideoFile(name: string): boolean {
  const ext = name.substring(name.lastIndexOf('.')).toLowerCase()
  return VIDEO_EXTENSIONS.has(ext)
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  }
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function formatDateTime(dateStr: string, timezone?: string): string {
  const d = new Date(dateStr)
  const opts: Intl.DateTimeFormatOptions = {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }
  if (timezone) opts.timeZone = timezone
  return d.toLocaleString('en-US', opts).replace(',', '')
}

export function formatElapsed(startedAt?: string): string {
  if (!startedAt) return ''
  const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)
  if (elapsed < 0) return '0s'
  if (elapsed < 60) return `${elapsed}s`
  const min = Math.floor(elapsed / 60)
  const sec = elapsed % 60
  return `${min}m ${sec}s`
}

export function estimateRemaining(startedAt?: string, progress?: number): string | null {
  if (!startedAt || !progress || progress <= 0 || progress >= 1) return null
  const elapsed = (Date.now() - new Date(startedAt).getTime()) / 1000
  if (elapsed < 5) return null
  const remaining = elapsed * (1 - progress) / progress
  if (remaining < 60) return `~${Math.ceil(remaining)}s`
  const min = Math.floor(remaining / 60)
  const sec = Math.ceil(remaining % 60)
  return `~${min}m ${sec}s`
}

export function formatDurationBetween(start?: string, end?: string): string {
  if (!start || !end) return ''
  const ms = new Date(end).getTime() - new Date(start).getTime()
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const s = sec % 60
  return `${min}m ${s}s`
}

export function timeAgo(dateStr?: string): string {
  if (!dateStr) return ''
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (diff < 0) return 'just now'
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export function shortFileName(filePath: string, maxLength?: number): string {
  const parts = filePath.split('/')
  const name = parts[parts.length - 1]
  if (maxLength && name.length > maxLength) return name.slice(0, maxLength - 3) + '...'
  return name
}
