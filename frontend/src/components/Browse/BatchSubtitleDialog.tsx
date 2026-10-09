import type { FileEntry } from '@/api/files'
import type { SubtitleTaskMode } from '@/api/subtitle'
import { isVideoFile } from '@/utils/format'
import SubtitleTaskDialog from '@/components/Subtitles/SubtitleTaskDialog'

export default function BatchSubtitleDialog({
  mode,
  files,
  subtitleId,
  onClose,
}: {
  mode: SubtitleTaskMode
  files: FileEntry[]
  subtitleId?: string
  onClose: () => void
}) {
  const paths = files
    .filter((f) => !f.is_dir && isVideoFile(f.name))
    .map((f) => f.path)
  return (
    <SubtitleTaskDialog
      paths={paths}
      initialMode={mode}
      subtitleId={subtitleId}
      onClose={onClose}
    />
  )
}
