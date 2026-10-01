import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { SkipForward, X } from 'lucide-react'
import { getSiblings } from '@/api/files'
import { usePlayerStore } from '@/stores/playerStore'
import { encodeMediaPath } from '@/utils/mediaPath'

interface NextEpisodeOverlayProps {
  path: string
  ended: boolean
}

export default function NextEpisodeOverlay({ path, ended }: NextEpisodeOverlayProps) {
  const navigate = useNavigate()
  const { currentTime, duration } = usePlayerStore()
  const [nextFile, setNextFile] = useState<string | null>(null)
  const [nextPath, setNextPath] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(10)
  const [dismissed, setDismissed] = useState(false)
  const showOverlay = !!nextFile && !dismissed && duration > 0 && (ended || duration - currentTime <= 30)

  // Fetch siblings and determine next file
  useEffect(() => {
    let cancelled = false
    setNextFile(null)
    setNextPath(null)
    setDismissed(false)
    setCountdown(10)

    getSiblings(path)
      .then(({ data }) => {
        if (cancelled) return
        const { current, dir, files } = data
        if (!files || files.length === 0) return
        const idx = files.indexOf(current)
        if (idx >= 0 && idx < files.length - 1) {
          const next = files[idx + 1]
          setNextFile(next)
          setNextPath(dir ? `${dir}/${next}` : next)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [path])

  // Automatic navigation starts only after the media element actually ends.
  useEffect(() => {
    if (!ended) { setCountdown(10); return }
    if (!nextPath || dismissed) return

    const timer = setInterval(() => {
      setCountdown((prev) => Math.max(0, prev - 1))
    }, 1000)

    return () => clearInterval(timer)
  }, [ended, dismissed, nextPath])

  useEffect(() => {
    if (ended && !dismissed && countdown === 0 && nextPath) navigate(`/watch/${encodeMediaPath(nextPath)}`)
  }, [ended, dismissed, countdown, nextPath, navigate])

  const playNow = useCallback(() => {
    if (nextPath) navigate(`/watch/${encodeMediaPath(nextPath)}`)
  }, [nextPath, navigate])

  const dismiss = useCallback(() => {
    setDismissed(true)
  }, [])

  if (!showOverlay || !nextFile || dismissed) return null

  return (
    <div className="absolute bottom-20 right-4 z-40 bg-dark-800/95 backdrop-blur-sm border border-dark-600 rounded-xl p-4 w-72 shadow-2xl animate-slide-in">
      <div className="flex items-start justify-between mb-3">
        <span className="text-xs text-gray-400 uppercase tracking-wide">Up Next</span>
        <button onClick={dismiss} className="text-gray-500 hover:text-gray-300">
          <X className="w-4 h-4" />
        </button>
      </div>
      <p className="text-sm text-white font-medium truncate mb-3" title={nextFile}>
        {nextFile}
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={playNow}
          className="flex items-center gap-1.5 bg-primary-600 hover:bg-primary-500 text-white text-sm px-3 py-1.5 rounded-lg transition-colors flex-1"
        >
          <SkipForward className="w-4 h-4" />
          Play Now
        </button>
        <span className="text-xs text-gray-500 tabular-nums shrink-0">
          {ended ? `${countdown}s` : '종료 후 이동'}
        </span>
      </div>
      {/* Countdown progress bar */}
      <div className="h-0.5 bg-dark-700 rounded-full mt-2 overflow-hidden">
        <div
          className="h-full bg-primary-500 transition-all duration-1000 ease-linear"
          style={{ width: ended ? `${(countdown / 10) * 100}%` : '0%' }}
        />
      </div>
    </div>
  )
}
