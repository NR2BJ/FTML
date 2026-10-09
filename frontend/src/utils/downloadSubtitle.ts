import { convertSubtitle, type SubtitleEntry } from '@/api/subtitle'

export async function downloadSubtitle(
  path: string,
  subtitle: SubtitleEntry,
  format: string
) {
  const { data } = await convertSubtitle(path, subtitle.id, format)
  const url = URL.createObjectURL(new Blob([data as BlobPart]))
  const link = document.createElement('a')
  link.href = url
  link.download = `${subtitle.label}.${format}`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10000)
}
