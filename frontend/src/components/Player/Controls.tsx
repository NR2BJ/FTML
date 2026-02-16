import { RefObject, useState, useEffect, useRef } from 'react'
import { usePlayerStore } from '@/stores/playerStore'
import { useToastStore } from '@/stores/toastStore'
import { Play, Pause, Volume2, VolumeX, Maximize, SkipBack, SkipForward, BarChart2, PictureInPicture2, Camera, Repeat } from 'lucide-react'
import { formatDuration } from '@/utils/format'
import { captureScreenshot } from '@/utils/screenshot'
import { toggleABLoopWithToast } from '@/utils/abloop'
import SubtitleSelector from './SubtitleSelector'
import AudioSelector from './AudioSelector'
import QualitySelector from './QualitySelector'
import ChapterList from './ChapterList'

interface ControlsProps {
  videoRef: RefObject<HTMLVideoElement | null>
  onTogglePlay: () => void
  onSeek: (time: number) => void
  onToggleFullscreen: () => void
  filePath: string
}

export default function Controls({ videoRef, onTogglePlay, onSeek, onToggleFullscreen, filePath }: ControlsProps) {
  const {
    isPlaying,
    currentTime,
    duration,
    volume,
    muted,
    playbackRate,
    showStats,
    abLoop,
    chapters,
    setVolume,
    setMuted,
    setPlaybackRate,
    setShowStats,
    toggleABLoop,
    clearABLoop,
  } = usePlayerStore()
  const addToast = useToastStore((s) => s.addToast)
  const [dragging, setDragging] = useState(false)
  const progressBarRef = useRef<HTMLDivElement>(null)

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  const handleProgressDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(true)
    const rect = e.currentTarget.getBoundingClientRect()
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    onSeek(percent * duration)
  }

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    setDragging(true)
    const rect = e.currentTarget.getBoundingClientRect()
    const percent = Math.max(0, Math.min(1, (e.touches[0].clientX - rect.left) / rect.width))
    onSeek(percent * duration)
  }

  // Drag-to-seek: window-level listeners
  useEffect(() => {
    if (!dragging) return
    const bar = progressBarRef.current
    const handleMove = (e: MouseEvent) => {
      if (!bar) return
      const rect = bar.getBoundingClientRect()
      const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      onSeek(percent * duration)
    }
    const handleTouchMove = (e: TouchEvent) => {
      if (!bar) return
      const rect = bar.getBoundingClientRect()
      const percent = Math.max(0, Math.min(1, (e.touches[0].clientX - rect.left) / rect.width))
      onSeek(percent * duration)
    }
    const handleUp = () => setDragging(false)
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    window.addEventListener('touchmove', handleTouchMove)
    window.addEventListener('touchend', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      window.removeEventListener('touchmove', handleTouchMove)
      window.removeEventListener('touchend', handleUp)
    }
  }, [dragging, duration, onSeek])

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value)
    setVolume(v)
    if (videoRef.current) {
      videoRef.current.volume = v
    }
    if (v > 0 && muted) {
      setMuted(false)
      if (videoRef.current) videoRef.current.muted = false
    }
  }

  const toggleMute = () => {
    setMuted(!muted)
    if (videoRef.current) videoRef.current.muted = !muted
  }

  const cycleSpeed = () => {
    const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2]
    const idx = speeds.indexOf(playbackRate)
    const next = speeds[(idx + 1) % speeds.length]
    setPlaybackRate(next)
    if (videoRef.current) videoRef.current.playbackRate = next
  }

  // PiP toggle
  const togglePiP = async () => {
    const video = videoRef.current
    if (!video) return
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture()
      } else if (document.pictureInPictureEnabled) {
        await video.requestPictureInPicture()
      }
    } catch {
      addToast({ type: 'error', message: 'PiP not supported' })
    }
  }

  // Screenshot
  const takeScreenshot = () => {
    const video = videoRef.current
    if (!video) return
    if (captureScreenshot(video, filePath, currentTime)) {
      addToast({ type: 'success', message: 'Screenshot saved' })
    } else {
      addToast({ type: 'error', message: 'Screenshot failed' })
    }
  }

  // A-B Loop
  const handleABLoop = () => toggleABLoopWithToast(currentTime)

  // A-B loop progress positions
  const loopAPos = abLoop.a !== null && duration > 0 ? (abLoop.a / duration) * 100 : null
  const loopBPos = abLoop.b !== null && duration > 0 ? (abLoop.b / duration) * 100 : null

  return (
    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300">
      {/* Progress bar */}
      <div
        ref={progressBarRef}
        className="mx-4 mb-2 cursor-pointer group/progress py-2 relative select-none"
        onMouseDown={handleProgressDown}
        onTouchStart={handleTouchStart}
      >
      <div className="h-1 bg-gray-600 rounded-full group-hover/progress:h-2 transition-all relative">
        <div
          className="h-full bg-primary-500 rounded-full relative"
          style={{ width: `${progress}%` }}
        >
          <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-primary-500 rounded-full opacity-0 group-hover/progress:opacity-100 transition-opacity" />
        </div>
        {/* A-B Loop markers */}
        {loopAPos !== null && (
          <div
            className="absolute top-1/2 -translate-y-1/2 w-1 h-3 bg-yellow-400 rounded-full z-10"
            style={{ left: `${loopAPos}%` }}
            title={`A: ${formatDuration(abLoop.a!)}`}
          />
        )}
        {loopBPos !== null && (
          <div
            className="absolute top-1/2 -translate-y-1/2 w-1 h-3 bg-yellow-400 rounded-full z-10"
            style={{ left: `${loopBPos}%` }}
            title={`B: ${formatDuration(abLoop.b!)}`}
          />
        )}
        {/* A-B Loop highlight region */}
        {loopAPos !== null && loopBPos !== null && (
          <div
            className="absolute top-0 bottom-0 bg-yellow-400/20 pointer-events-none"
            style={{ left: `${loopAPos}%`, width: `${loopBPos - loopAPos}%` }}
          />
        )}
        {/* Chapter markers */}
        {duration > 0 && chapters.map((ch, i) => (
          <div
            key={i}
            className="absolute top-0 bottom-0 w-0.5 bg-yellow-500/60 z-10 pointer-events-none"
            style={{ left: `${(ch.start_time / duration) * 100}%` }}
            title={ch.title || `Chapter ${i + 1}`}
          />
        ))}
      </div>
      </div>

      {/* Controls bar */}
      <div className="flex items-center gap-3 px-4 pb-3">
        {/* Play/Pause */}
        <button onClick={onTogglePlay} className="text-white hover:text-primary-400 transition-colors">
          {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6" />}
        </button>

        {/* Skip buttons */}
        <button
          onClick={() => onSeek(Math.max(0, currentTime - 10))}
          className="text-gray-300 hover:text-white transition-colors"
        >
          <SkipBack className="w-5 h-5" />
        </button>
        <button
          onClick={() => onSeek(Math.min(duration, currentTime + 10))}
          className="text-gray-300 hover:text-white transition-colors"
        >
          <SkipForward className="w-5 h-5" />
        </button>

        {/* Time */}
        <span className="text-sm text-gray-300 tabular-nums">
          {formatDuration(currentTime)} / {formatDuration(duration)}
        </span>

        <div className="flex-1" />

        {/* Audio Track */}
        <AudioSelector />

        {/* Chapters */}
        <ChapterList onSeek={onSeek} />

        {/* Subtitles */}
        <SubtitleSelector />

        {/* Quality */}
        <QualitySelector />

        {/* A-B Loop */}
        <button
          onClick={handleABLoop}
          className={`transition-colors px-1 ${
            abLoop.a !== null ? 'text-yellow-400 hover:text-yellow-300' : 'text-gray-300 hover:text-white'
          }`}
          title={abLoop.a === null ? 'Set loop point A (B)' : abLoop.b === null ? 'Set loop point B (B)' : 'Clear A-B loop (B)'}
        >
          <Repeat className="w-4.5 h-4.5" />
        </button>

        {/* Screenshot */}
        <button
          onClick={takeScreenshot}
          className="text-gray-300 hover:text-white transition-colors px-1"
          title="Screenshot (S)"
        >
          <Camera className="w-4.5 h-4.5" />
        </button>

        {/* PiP */}
        {document.pictureInPictureEnabled && (
          <button
            onClick={togglePiP}
            className="text-gray-300 hover:text-white transition-colors px-1"
            title="Picture-in-Picture (P)"
          >
            <PictureInPicture2 className="w-4.5 h-4.5" />
          </button>
        )}

        {/* Speed */}
        <button
          onClick={cycleSpeed}
          className="text-sm text-gray-300 hover:text-white transition-colors px-1"
        >
          {playbackRate}x
        </button>

        {/* Stats toggle */}
        <button
          onClick={() => setShowStats(!showStats)}
          className={`transition-colors px-1 ${
            showStats ? 'text-blue-400 hover:text-blue-300' : 'text-gray-300 hover:text-white'
          }`}
          title="Toggle stats (I)"
        >
          <BarChart2 className="w-5 h-5" />
        </button>

        {/* Volume */}
        <div className="flex items-center gap-1">
          <button onClick={toggleMute} className="text-gray-300 hover:text-white transition-colors">
            {muted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={muted ? 0 : volume}
            onChange={handleVolumeChange}
            className="w-20 h-1 accent-primary-500"
          />
        </div>

        {/* Fullscreen */}
        <button
          onClick={onToggleFullscreen}
          className="text-gray-300 hover:text-white transition-colors"
        >
          <Maximize className="w-5 h-5" />
        </button>
      </div>
    </div>
  )
}
