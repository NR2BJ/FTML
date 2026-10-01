export function createSessionID(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

export function normalizeSeekTime(time: number): number {
  return Number.isFinite(time) ? Math.max(0, Math.round(time * 1000) / 1000) : 0
}
