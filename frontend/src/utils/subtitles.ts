interface SubtitleCue {
  start: number
  end: number
  text: string
}


export function parseVTT(vttText: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const blocks = vttText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/)

  for (const block of blocks) {
    const lines = block.trim().split('\n')
    if (/^(NOTE(?:\s|$)|STYLE$|REGION$)/.test(lines[0])) continue
    let timestampLine = -1

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) {
        timestampLine = i
        break
      }
    }

    if (timestampLine === -1) continue

    const match = lines[timestampLine].match(
      /^(\d{1,6}:)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,6}:)?(\d{2}):(\d{2})[.,](\d{3})(?:\s+.*)?$/
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
      .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
        const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
        if (named[code]) return named[code]
        const value = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
        return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : entity
      })
      .trim()

    if (text && end > start && startM < 60 && endM < 60 && startS < 60 && endS < 60) {
      cues.push({ start, end, text })
    }
  }

  return cues
}
