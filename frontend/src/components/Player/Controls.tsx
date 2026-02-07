import { RefObject } from 'react'
import { usePlayerStore } from '@/stores/playerStore'
import { Play, Pause, Volume2, VolumeX, Maximize, SkipBack, SkipForward, BarChart2 } from 'lucide-react'
import { formatDuration } from '@/utils/format'
import SubtitleSelector from './SubtitleSelector'
import AudioSelector from './AudioSelector'
import QualitySelector from './QualitySelector'

interface ControlsProps {
  videoRef: RefObject<HTMLVideoElement | null>
  onTogglePlay: () => void
  onSeek: (time: number) => void
  onToggleFullscreen: () => void
}

export default function Controls({ videoRef, onTogglePlay, onSeek, onToggleFullscreen }: ControlsProps) {
  const {
    isPlaying,
    currentTime,
    duration,
    volume,
    muted,
    playbackRate,
    showStats,
    setVolume,
    setMuted,
    setPlaybackRate,
    setShowStats,
  } = usePlayerStore()

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const percent = (e.clientX - rect.left) / rect.width
    onSeek(percent * duration)
  }

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

  return (
    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300">
      {/* Progress bar */}
      <div
        className="h-1 mx-4 mb-2 bg-gray-600 rounded-full cursor-pointer group/progress hover:h-2 transition-all"
        onClick={handleProgressClick}
      >
        <div
          className="h-full bg-primary-500 rounded-full relative"
          style={{ width: `${progress}%` }}
        >
          <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-primary-500 rounded-full opacity-0 group-hover/progress:opacity-100 transition-opacity" />
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

        {/* Subtitles */}
        <SubtitleSelector />

        {/* Quality */}
        <QualitySelector />

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
