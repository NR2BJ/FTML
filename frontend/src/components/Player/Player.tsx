import { useRef, useEffect, useState, useCallback } from 'react'
import Hls from 'hls.js'
import { getHLSUrl, getDirectUrl } from '@/api/stream'
import { getFileInfo } from '@/api/files'
import { saveWatchPosition, getWatchPosition } from '@/api/user'
import { listSubtitles } from '@/api/subtitle'
import { usePlayerStore } from '@/stores/playerStore'
import Controls from './Controls'
import PlaybackStats from './PlaybackStats'
import SubtitleDisplay from './SubtitleDisplay'

interface PlayerProps {
  path: string
}

export default function Player({ path }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const probeDurationRef = useRef<number>(0)
  const lastSavedTimeRef = useRef<number>(0)
  const hlsStartTimeRef = useRef<number>(0) // HLS transcode start offset
  const [useHLS, setUseHLS] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const {
    isPlaying,
    volume,
    muted,
    playbackRate,
    resumePosition,
    hasResumed,
    showStats,
    activeSubtitle,
    subtitleVisible,
    quality,
    duration,
    setPlaying,
    setCurrentTime,
    setDuration,
    setCurrentFile,
    setPlaybackRate,
    setResumePosition,
    setHasResumed,
    setMediaInfo,
    setShowStats,
    setSubtitles,
    setActiveSubtitle,
    setSubtitleVisible,
  } = usePlayerStore()

  // Helper to start HLS playback from a given time
  const startHLS = useCallback((videoEl: HTMLVideoElement, filePath: string, q: string, startTime: number = 0, autoPlay: boolean = false) => {
    // Cleanup previous HLS instance
    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    hlsStartTimeRef.current = startTime

    if (Hls.isSupported()) {
      const token = localStorage.getItem('token') || ''
      const hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferHole: 0.5,
        highBufferWatchdogPeriod: 3,
        startFragPrefetch: true,
        xhrSetup: (xhr: XMLHttpRequest) => {
          xhr.setRequestHeader('Authorization', `Bearer ${token}`)
        },
      })
      hlsRef.current = hls
      hls.loadSource(getHLSUrl(filePath, q, startTime))
      hls.attachMedia(videoEl)
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          setError(`Playback error: ${data.type}`)
        }
      })
      if (autoPlay) {
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          videoEl.play()
        })
      }
      setUseHLS(true)
    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      videoEl.src = getHLSUrl(filePath, q, startTime)
      setUseHLS(true)
      if (autoPlay) {
        videoEl.addEventListener('canplay', () => videoEl.play(), { once: true })
      }
    } else {
      setError('HLS is not supported in this browser')
    }
  }, [])

  // Seek to absolute time. If beyond buffered range in HLS, restart transcoding.
  const seek = useCallback((absTime: number) => {
    const video = videoRef.current
    if (!video) return

    const fullDur = probeDurationRef.current || duration
    const clampedTime = Math.max(0, Math.min(absTime, fullDur))

    // For direct play (not HLS), just seek directly
    if (!useHLS) {
      video.currentTime = clampedTime
      return
    }

    // Calculate the relative time within the current HLS session
    const relativeTime = clampedTime - hlsStartTimeRef.current

    // Check if the target is within the currently available buffered range
    let maxBufferedEnd = 0
    for (let i = 0; i < video.buffered.length; i++) {
      maxBufferedEnd = Math.max(maxBufferedEnd, video.buffered.end(i))
    }

    // If the seek target is within range (or close enough), seek directly
    // Allow seeking up to 5s beyond current buffer (it will load)
    if (relativeTime >= 0 && relativeTime <= maxBufferedEnd + 5) {
      video.currentTime = relativeTime
      return
    }

    // Beyond the buffered range: restart HLS from the new position
    const wasPlaying = !video.paused
    startHLS(video, path, quality, clampedTime, wasPlaying)
  }, [path, quality, duration, useHLS, startHLS])

  // Reset state and fetch file info when path changes
  useEffect(() => {
    // Reset all player state for new video
    setCurrentTime(0)
    setDuration(0)
    setPlaying(false)
    setResumePosition(null)
    setHasResumed(false)
    setMediaInfo(null)
    setSubtitles([])
    setActiveSubtitle(null)
    probeDurationRef.current = 0
    lastSavedTimeRef.current = 0
    hlsStartTimeRef.current = 0

    // Fetch real duration and media info from FFprobe
    getFileInfo(path)
      .then(({ data }) => {
        setMediaInfo(data)
        if (data.duration) {
          const dur = parseFloat(data.duration)
          probeDurationRef.current = dur
          setDuration(dur)
        }
      })
      .catch(() => {})

    // Fetch saved watch position for resume
    getWatchPosition(path)
      .then(({ data }) => {
        if (data.position && data.position > 0) {
          setResumePosition(data.position)
        }
      })
      .catch(() => {})

    // Fetch available subtitles
    listSubtitles(path)
      .then(({ data }) => {
        if (data && data.length > 0) {
          setSubtitles(data)
        }
      })
      .catch(() => {})
  }, [path, setCurrentTime, setDuration, setPlaying, setResumePosition, setHasResumed, setMediaInfo, setSubtitles, setActiveSubtitle])

  // Resume playback from saved position after media is ready
  useEffect(() => {
    const video = videoRef.current
    if (!video || hasResumed || resumePosition === null) return

    const handleCanPlay = () => {
      const dur = probeDurationRef.current || video.duration
      // Don't resume if near the end (within last 10 seconds)
      if (resumePosition > 0 && resumePosition < dur - 10) {
        // Use the seek function which handles HLS restarts for far positions
        seek(resumePosition)
      }
      setHasResumed(true)
    }

    // If video is already ready, seek immediately
    if (video.readyState >= 3) {
      handleCanPlay()
    } else {
      video.addEventListener('canplay', handleCanPlay, { once: true })
      return () => video.removeEventListener('canplay', handleCanPlay)
    }
  }, [resumePosition, hasResumed, setHasResumed, seek])

  // Auto-save watch position every 10 seconds + on pause
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const savePosition = () => {
      const absTime = video.currentTime + hlsStartTimeRef.current
      const dur = probeDurationRef.current || video.duration
      if (absTime > 0 && dur > 0 && Math.abs(absTime - lastSavedTimeRef.current) > 2) {
        lastSavedTimeRef.current = absTime
        saveWatchPosition(path, absTime, dur).catch(() => {})
      }
    }

    const interval = setInterval(savePosition, 10000)

    const handlePause = () => savePosition()

    video.addEventListener('pause', handlePause)

    return () => {
      clearInterval(interval)
      video.removeEventListener('pause', handlePause)
      // Save on unmount
      savePosition()
    }
  }, [path])

  // Initialize player (reacts to path and quality changes)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    setCurrentFile(path)
    setError(null)

    // Save current absolute time for quality switches (not new videos)
    const prevStartOffset = hlsStartTimeRef.current
    const savedAbsTime = (video.currentTime || 0) + prevStartOffset
    const wasPlaying = !video.paused

    // Cleanup previous HLS instance
    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    // Direct play for browser-compatible formats or "original" quality
    const ext = path.substring(path.lastIndexOf('.')).toLowerCase()
    if (quality === 'original' || ext === '.mp4' || ext === '.webm') {
      video.src = getDirectUrl(path)
      setUseHLS(false)
      hlsStartTimeRef.current = 0
      // Seek back if quality switch
      if (savedAbsTime > 0) {
        video.addEventListener('loadedmetadata', () => {
          video.currentTime = savedAbsTime
          if (wasPlaying) video.play()
        }, { once: true })
      }
      return
    }

    // Use HLS for other formats
    // For quality switch, start from the saved position
    if (savedAbsTime > 0) {
      startHLS(video, path, quality, savedAbsTime, wasPlaying)
    } else {
      startHLS(video, path, quality, 0, false)
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [path, quality, setCurrentFile, startHLS])

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
      // Report absolute time (HLS video.currentTime is relative to transcode start)
      setCurrentTime(video.currentTime + hlsStartTimeRef.current)
    }
  }, [setCurrentTime])

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current
    if (video && isFinite(video.duration) && video.duration > 0) {
      // For direct play, use the video's reported duration
      // For HLS, prefer FFprobe duration since video.duration only reflects transcoded portion
      if (!useHLS && video.duration > probeDurationRef.current) {
        setDuration(video.duration)
      }
    }
  }, [setDuration, useHLS])

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
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      // Current absolute time (video.currentTime is relative to HLS start offset)
      const absTime = video.currentTime + hlsStartTimeRef.current
      const fullDur = probeDurationRef.current || duration

      switch (e.key) {
        case ' ':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowLeft':
          e.preventDefault()
          seek(absTime - 5)
          break
        case 'ArrowRight':
          e.preventDefault()
          seek(absTime + 5)
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
          seek(absTime - 10)
          break
        case 'l':
        case 'L':
          seek(absTime + 10)
          break
        case 'i':
        case 'I':
          setShowStats(!showStats)
          break
        case 'c':
        case 'C':
          setSubtitleVisible(!subtitleVisible)
          break
        case '<': {
          // Decrease speed (Shift + ,)
          const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]
          const curIdx = speeds.indexOf(playbackRate)
          if (curIdx > 0) {
            const newRate = speeds[curIdx - 1]
            setPlaybackRate(newRate)
            video.playbackRate = newRate
          }
          break
        }
        case '>': {
          // Increase speed (Shift + .)
          const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]
          const curIdx = speeds.indexOf(playbackRate)
          if (curIdx < speeds.length - 1) {
            const newRate = speeds[curIdx + 1]
            setPlaybackRate(newRate)
            video.playbackRate = newRate
          }
          break
        }
        default:
          // 0-9: jump to percentage of full duration
          if (e.key >= '0' && e.key <= '9' && fullDur > 0) {
            const pct = parseInt(e.key) * 10
            seek((pct / 100) * fullDur)
          }
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [togglePlay, toggleFullscreen, seek, showStats, setShowStats, subtitleVisible, setSubtitleVisible, playbackRate, setPlaybackRate, duration])

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
      <SubtitleDisplay videoRef={videoRef} path={path} />
      <PlaybackStats videoRef={videoRef} hlsRef={hlsRef} />
      <Controls
        videoRef={videoRef}
        onTogglePlay={togglePlay}
        onSeek={seek}
        onToggleFullscreen={toggleFullscreen}
      />
    </div>
  )
}
