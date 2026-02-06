import { useRef, useEffect, useState, useCallback } from 'react'
import Hls from 'hls.js'
import { getHLSUrl, getDirectUrl } from '@/api/stream'
import { getFileInfo } from '@/api/files'
import { usePlayerStore } from '@/stores/playerStore'
import Controls from './Controls'
import { formatDuration } from '@/utils/format'

interface PlayerProps {
  path: string
}

export default function Player({ path }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const probeDurationRef = useRef<number>(0)
  const [useHLS, setUseHLS] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const {
    isPlaying,
    volume,
    muted,
    playbackRate,
    setPlaying,
    setCurrentTime,
    setDuration,
    setCurrentFile,
  } = usePlayerStore()

  // Reset state and fetch file info when path changes
  useEffect(() => {
    // Reset all player state for new video
    setCurrentTime(0)
    setDuration(0)
    setPlaying(false)
    probeDurationRef.current = 0

    // Fetch real duration from FFprobe
    getFileInfo(path)
      .then(({ data }) => {
        if (data.duration) {
          const dur = parseFloat(data.duration)
          probeDurationRef.current = dur
          setDuration(dur)
        }
      })
      .catch(() => {})
  }, [path, setCurrentTime, setDuration, setPlaying])

  // Initialize player
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    setCurrentFile(path)
    setError(null)

    // Cleanup previous HLS instance
    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    // Try direct play first for browser-compatible formats
    const ext = path.substring(path.lastIndexOf('.')).toLowerCase()
    if (ext === '.mp4' || ext === '.webm') {
      video.src = getDirectUrl(path)
      setUseHLS(false)
      return
    }

    // Use HLS for other formats
    if (Hls.isSupported()) {
      const token = localStorage.getItem('token') || ''
      const hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        xhrSetup: (xhr: XMLHttpRequest) => {
          xhr.setRequestHeader('Authorization', `Bearer ${token}`)
        },
      })
      hlsRef.current = hls
      hls.loadSource(getHLSUrl(path))
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          setError(`Playback error: ${data.type}`)
        }
      })
      setUseHLS(true)
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = getHLSUrl(path)
      setUseHLS(true)
    } else {
      setError('HLS is not supported in this browser')
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [path, setCurrentFile])

  // Sync volume/muted/playbackRate
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.volume = volume
    video.muted = muted
    video.playbackRate = playbackRate
  }, [volume, muted, playbackRate])

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current
    if (video) {
      setCurrentTime(video.currentTime)
    }
  }, [setCurrentTime])

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current
    if (video && isFinite(video.duration) && video.duration > 0) {
      // Only update if video reports a longer duration than FFprobe
      // (HLS initially reports only buffered segment length)
      if (video.duration > probeDurationRef.current) {
        setDuration(video.duration)
      }
    }
  }, [setDuration])

  const handlePlay = useCallback(() => setPlaying(true), [setPlaying])
  const handlePause = useCallback(() => setPlaying(false), [setPlaying])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      video.play()
    } else {
      video.pause()
    }
  }, [])

  const seek = useCallback((time: number) => {
    const video = videoRef.current
    if (video) {
      video.currentTime = time
    }
  }, [])

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      container.requestFullscreen()
    }
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const video = videoRef.current
      if (!video) return
      if (e.target instanceof HTMLInputElement) return

      switch (e.key) {
        case ' ':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowLeft':
          e.preventDefault()
          video.currentTime -= 5
          break
        case 'ArrowRight':
          e.preventDefault()
          video.currentTime += 5
          break
        case 'ArrowUp':
          e.preventDefault()
          video.volume = Math.min(1, video.volume + 0.1)
          break
        case 'ArrowDown':
          e.preventDefault()
          video.volume = Math.max(0, video.volume - 0.1)
          break
        case 'f':
        case 'F':
          toggleFullscreen()
          break
        case 'm':
        case 'M':
          video.muted = !video.muted
          break
        case 'j':
        case 'J':
          video.currentTime -= 10
          break
        case 'l':
        case 'L':
          video.currentTime += 10
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [togglePlay, toggleFullscreen])

  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-black rounded-lg">
        <div className="text-red-400 text-center">
          <p className="text-lg mb-2">Playback Error</p>
          <p className="text-sm text-gray-500">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="relative bg-black rounded-lg overflow-hidden h-full group"
    >
      <video
        ref={videoRef}
        className="w-full h-full object-contain cursor-pointer"
        onClick={togglePlay}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onPlay={handlePlay}
        onPause={handlePause}
      />
      <Controls
        videoRef={videoRef}
        onTogglePlay={togglePlay}
        onSeek={seek}
        onToggleFullscreen={toggleFullscreen}
      />
    </div>
  )
}
