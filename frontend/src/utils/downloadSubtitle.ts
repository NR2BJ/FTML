import { convertSubtitle, type SubtitleEntry } from '@/api/subtitle'

export function subtitleDownloadName(label: string, format: string) {
  const clean = label.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()
  const encoder = new TextEncoder()
  let name = ''
  // 긴 원본 ASS 이름을 포함해도 파일명 길이 제한 안에 확장자를 남긴다.
  for (const char of clean) {
    if (encoder.encode(name + char).length > 200) break
    name += char
  }
  return `${name || '자막'}.${format}`
}

export async function downloadSubtitle(
  path: string,
  subtitle: SubtitleEntry,
  format: string
) {
  const { data } = await convertSubtitle(path, subtitle.id, format)
  const url = URL.createObjectURL(new Blob([data as BlobPart]))
  const link = document.createElement('a')
  link.href = url
  link.download = subtitleDownloadName(subtitle.label, format)
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10000)
}
