import { usePlayerStore } from '@/stores/playerStore'
import type { SubtitleEntry } from '@/api/subtitle'
import SubtitleTaskDialog from '@/components/Subtitles/SubtitleTaskDialog'

export default function SubtitleTranslate({
  sourceSubtitle,
  onClose,
}: {
  sourceSubtitle: SubtitleEntry
  onClose: () => void
}) {
  const { currentFile, audioTrack } = usePlayerStore()
  return currentFile ? (
    <SubtitleTaskDialog
      paths={[currentFile]}
      initialMode="translate"
      subtitleId={sourceSubtitle.id}
      audioTrack={audioTrack}
      onClose={onClose}
    />
  ) : null
}
