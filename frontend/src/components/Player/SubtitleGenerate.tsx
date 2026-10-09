import { usePlayerStore } from '@/stores/playerStore'
import SubtitleTaskDialog from '@/components/Subtitles/SubtitleTaskDialog'

export default function SubtitleGenerate({ onClose }: { onClose: () => void }) {
  const { currentFile, audioTrack } = usePlayerStore()
  return currentFile ? (
    <SubtitleTaskDialog
      paths={[currentFile]}
      initialMode="generate"
      audioTrack={audioTrack}
      onClose={onClose}
    />
  ) : null
}
