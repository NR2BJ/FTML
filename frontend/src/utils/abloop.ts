import { usePlayerStore } from '@/stores/playerStore'
import { useToastStore } from '@/stores/toastStore'
import { formatDuration } from './format'

/**
 * Toggle A-B loop at the given time and show a toast notification.
 * First call sets point A, second call sets point B, third call clears.
 */
export function toggleABLoopWithToast(time: number): void {
  usePlayerStore.getState().toggleABLoop(time)
  const { abLoop } = usePlayerStore.getState()
  const addToast = useToastStore.getState().addToast

  if (abLoop.a !== null && abLoop.b === null) {
    addToast({ type: 'info', message: `Loop A set at ${formatDuration(time)}` })
  } else if (abLoop.a !== null && abLoop.b !== null) {
    addToast({ type: 'info', message: `Loop B set at ${formatDuration(abLoop.b)}` })
  } else {
    addToast({ type: 'info', message: 'A-B loop cleared' })
  }
}
