import { useRef, useEffect, useState, useCallback } from 'react'
import Hls from 'hls.js'
import { getHLSUrl, getDirectUrl, getPresets, getCapabilities, getSessionStatus, sendHeartbeat, stopSession, pauseSession, resumeSession } from '@/api/stream'
import { getFileInfo } from '@/api/files'
import { saveWatchPosition, getWatchPosition } from '@/api/user'
import { detectMediaCodecs } from '@/utils/codec'
import { createSessionID, normalizeSeekTime } from '@/utils/session'
import { buildPlaybackPlan, attemptKey, rejectAttempt, type PlaybackAttempt, type FailureReason } from '@/utils/playbackPlan'
import { PlaybackStartupWatch } from '@/utils/playbackStartup'
import { PlaybackHealthWatch } from '@/utils/playbackHealth'
import { getStoredAuthToken } from '@/utils/authToken'
import { usePlayerStore } from '@/stores/playerStore'
import { useToastStore } from '@/stores/toastStore'
import { formatDuration } from '@/utils/format'
import { captureScreenshot } from '@/utils/screenshot'
import { toggleABLoopWithToast } from '@/utils/abloop'
import Controls from './Controls'
import PlaybackStats from './PlaybackStats'
import SubtitleDisplay from './SubtitleDisplay'
import NextEpisodeOverlay from './NextEpisodeOverlay'
import { usePlayerSubtitles } from './usePlayerSubtitles'

const HEARTBEAT_INTERVAL_MS = 3000
const POSITION_SAVE_INTERVAL_MS = 10000

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
  const absTimeRef = useRef<number>(0)      // current absolute playback time (survives HLS destroy)
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sessionIDRef = useRef<string | null>(null)
  const startRequestSeqRef = useRef(0)
  const playbackIntentRef = useRef(true)
  const sourceChangingRef = useRef(false)
  const planRef = useRef<PlaybackAttempt[]>([])
  const rejectedRef = useRef(new Set<string>())
  const recoverRef = useRef<(reason: FailureReason) => boolean>(() => false)
  const [recoveryStep, setRecoveryStep] = useState(0)
  const [useHLS, setUseHLS] = useState(true)
  const [presetsReady, setPresetsReady] = useState(false)
  const [ended, setEnded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  const [gestureText, setGestureText] = useState<string | null>(null)
  const gestureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    qualityPresets,
    audioTrack,
    duration,
    negotiatedCodec,
    mediaInfo,
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
    setQualityPresets,
    setNegotiatedCodec,
    setBrowserCodecs,
  } = usePlayerStore()

  // Stop heartbeat timer
  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current)
      heartbeatRef.current = null
    }
  }, [])

  // Start heartbeat timer for a session
  const startHeartbeat = useCallback((sid: string) => {
    stopHeartbeat()
    sessionIDRef.current = sid
    // Send immediately, then every 15 seconds
    let pending = false
    const tick = async () => {
      if (pending || sessionIDRef.current !== sid) return
      pending = true
      try {
        await sendHeartbeat(sid, absTimeRef.current)
        const { data } = await getSessionStatus(sid)
        if (sessionIDRef.current !== sid) return
        usePlayerStore.setState({ playbackStatus: data })
        if (data.state === 'failed' && !recoverRef.current('server')) {
          sourceChangingRef.current = true
          stopHeartbeat()
          hlsRef.current?.destroy()
          hlsRef.current = null
          usePlayerStore.getState().setPlaying(false)
          stopSession(sid).catch(() => {})
          sessionIDRef.current = null
          setError('서버 변환이 중단됐고 사용 가능한 대체 방식도 실패했습니다. 서버의 해당 시각 로그를 확인해 주세요.')
        }
      } catch { /* 일시적인 상태 조회 실패로 변환 방식을 바꾸지 않는다. */ }
      finally { pending = false }
    }
    void tick()
    heartbeatRef.current = setInterval(tick, HEARTBEAT_INTERVAL_MS)
  }, [stopHeartbeat])

  // Stop the current HLS session on the server
  const stopCurrentSession = useCallback(() => {
    startRequestSeqRef.current += 1
    stopHeartbeat()
    if (sessionIDRef.current) {
      stopSession(sessionIDRef.current).catch(() => {})
      sessionIDRef.current = null
    }
  }, [stopHeartbeat])

  const tryCompatibilityPlayback = useCallback((_requestedQuality?: string, _codec?: string, reason: FailureReason = 'browser') => {
    const state = usePlayerStore.getState()
    const current = state.activeAttempt
    if (!current || rejectedRef.current.has(attemptKey(current))) return false
    const rejected = new Set(rejectedRef.current)
    rejectAttempt(planRef.current, current, reason, rejected)
    const next = planRef.current.find(a => !rejected.has(attemptKey(a)))
    if (!next) return false
    rejectedRef.current = rejected

    // Preserve user intent and absolute time while replacing the failed source.
    sourceChangingRef.current = true
    stopCurrentSession()
    hlsRef.current?.destroy()
    hlsRef.current = null
    state.setCompatibilityMode(true)
    setRecoveryStep(step => step + 1)
    useToastStore.getState().addToast({
      type: 'warning',
      message: `${reason === 'server' ? '서버 변환 중단' : reason === 'slow' ? '재생 처리 지연' : '브라우저 재생 오류'}으로 ${next.acceleration === 'copy' ? '영상 유지' : `${next.quality} ${next.codec.toUpperCase()}` + (next.acceleration === 'hybrid' ? ' CPU 디코딩·GPU 변환' : next.acceleration === 'software' ? ' CPU 변환' : ' GPU 변환')}을 시도합니다. 위치와 저장한 설정은 유지됩니다.`,
      duration: 7000,
    })
    return true
  }, [stopCurrentSession])
  recoverRef.current = reason => tryCompatibilityPlayback(undefined, undefined, reason)

  useEffect(() => {
    const watch = new PlaybackHealthWatch()
    const timer = setInterval(() => {
      const video = videoRef.current
      if (!video || sourceChangingRef.current || video.error) { watch.reset(); return }
      let buffer = 0
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) buffer = video.buffered.end(i)-video.currentTime
      }
      const frames = video.getVideoPlaybackQuality?.()
      const reason = watch.check({ now: performance.now(), time: video.currentTime + hlsStartTimeRef.current,
        rate: video.playbackRate, frames: frames?.totalVideoFrames ?? 0, dropped: frames?.droppedVideoFrames ?? 0,
        buffer, paused: video.paused, seeking: video.seeking, visible: !document.hidden,
        server: usePlayerStore.getState().playbackStatus ?? undefined })
      if (reason) recoverRef.current(reason)
    }, 1000)
    return () => clearInterval(timer)
  }, [path, quality, recoveryStep])

  // 파일의 해상도와 프로필을 포함해 브라우저/서버 공통 후보를 정한다.
  useEffect(() => {
    if (!mediaInfo) return
    let cancelled = false
    detectMediaCodecs(mediaInfo).then(codecs => {
      if (cancelled) return null
      setBrowserCodecs(codecs)
      return getCapabilities(codecs)
    })
      .then(response => {
        if (cancelled || !response) return
        const { data } = response
        usePlayerStore.setState({ serverEncoders: data.server_encoders })
        setNegotiatedCodec(
          data.selected_codec,
          data.selected_encoder,
          data.hwaccel
        )
      })
      .catch(() => {
        if (cancelled) return
        setError('브라우저와 서버의 재생 지원 정보를 확인하지 못했습니다. 다시 시도해 주세요.')
      })
    return () => { cancelled = true }
  }, [mediaInfo, setBrowserCodecs, setNegotiatedCodec])

  // Helper to start HLS playback from a given time
  const startHLS = useCallback((videoEl: HTMLVideoElement, filePath: string, q: string, startTime: number = 0, autoPlay: boolean = false) => {
    sourceChangingRef.current = true
    playbackIntentRef.current = autoPlay
    stopCurrentSession()
    const requestSeq = startRequestSeqRef.current + 1
    startRequestSeqRef.current = requestSeq

    // Cleanup previous HLS instance
    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    startTime = normalizeSeekTime(startTime)
    hlsStartTimeRef.current = startTime
    absTimeRef.current = startTime
    setEnded(false)

    // Get the current negotiated codec and audio track from the store
    const { audioTrack: storeAudioTrack, activeAttempt: attempt } = usePlayerStore.getState()
    if (!attempt) return
    const codec = attempt.codec
    q = attempt.quality

    const sid = createSessionID()
    startHeartbeat(sid)

    if (Hls.isSupported()) {
      const token = getStoredAuthToken()
      let sourceOrigin = startTime
      const hls = new Hls({
        startPosition: 0,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        backBufferLength: 60,
        maxBufferHole: 0.5,
        highBufferWatchdogPeriod: 3,
        startFragPrefetch: true,
        xhrSetup: (xhr: XMLHttpRequest) => {
          xhr.setRequestHeader('Authorization', `Bearer ${token}`)
          xhr.addEventListener('readystatechange', () => {
            if (xhr.readyState < 2) return
            if (startRequestSeqRef.current !== requestSeq) return
            const header = xhr.getResponseHeader('X-Media-Time-Origin')
            if (header !== null && Number.isFinite(Number(header))) sourceOrigin = Number(header)
          })
        },
      })
      hlsRef.current = hls
      let timelineReady = false
      let initialSeekDone = false
      hls.on(Hls.Events.INIT_PTS_FOUND, (_, data) => {
        if (startRequestSeqRef.current !== requestSeq || timelineReady) return
        const base = data.initPTS / data.timescale
        if (!Number.isFinite(base)) return
        // 서버는 영상과 음성의 공통 원본 시각을 보존한다. HLS.js가 제거한
        // 시작 시각을 되돌려 탐색/자막/이어보기 모두 같은 시간축을 쓴다.
        hlsStartTimeRef.current = sourceOrigin + base
        timelineReady = true
      })
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (startRequestSeqRef.current !== requestSeq || !timelineReady || initialSeekDone) return
        initialSeekDone = true
        videoEl.currentTime = Math.max(0, startTime - hlsStartTimeRef.current)
        videoEl.playbackRate = usePlayerStore.getState().playbackRate
        sourceChangingRef.current = false
        if (playbackIntentRef.current) videoEl.play().catch(() => {})
        else pauseSession(sid).catch(() => {})
      })
      let startupTimer: ReturnType<typeof setInterval> | null = null
      let startupFinished = false
      const clearStartupTimer = () => {
        if (startupTimer !== null) clearInterval(startupTimer)
        startupTimer = null
      }
      hls.on(Hls.Events.DESTROYING, clearStartupTimer)
      hls.on(Hls.Events.MEDIA_DETACHING, clearStartupTimer)
      hls.on(Hls.Events.BUFFER_APPENDED, (_, data) => {
        if (data.frag.sn === 'initSegment' || data.type === 'audio' || startupTimer !== null || startupFinished) return
        // 일부 HEVC 디코더는 append 성공 후에도 프레임을 버리고 오류를 보내지 않는다.
        const watch = new PlaybackStartupWatch()
        watch.check(performance.now(), videoEl.readyState, !document.hidden)
        startupTimer = setInterval(() => {
          if (startRequestSeqRef.current !== requestSeq || videoEl.error) {
            clearStartupTimer()
            return
          }
          const result = watch.check(performance.now(), videoEl.readyState, !document.hidden)
          if (result === 'waiting') return
          startupFinished = true
          clearStartupTimer()
          if (result === 'ready') return

          console.warn('[재생 시작 지연]', { session: sid, quality: q, codec, readyState: videoEl.readyState })
          if (tryCompatibilityPlayback(q, codec)) return
          sourceChangingRef.current = true
          stopCurrentSession()
          hls.destroy()
          hlsRef.current = null
          usePlayerStore.getState().setPlaying(false)
          setError('영상 데이터를 받았지만 브라우저가 재생을 시작하지 못했습니다. 다시 시도해 주세요.')
        }, 500)
      })
      let mediaRecoveryAttempts = 0
      let networkRecoveryAttempts = 0
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (startRequestSeqRef.current !== requestSeq) return
        if (!data.fatal) return

        const detail = `${data.type} / ${data.details} / media=${videoEl.error?.code ?? 0}`
        console.warn('[재생 오류]', { session: sid, quality: q, codec, detail })

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            if ((data.response?.code ?? 0) >= 500 && tryCompatibilityPlayback(q, codec, 'server')) return
            if (networkRecoveryAttempts < 2) {
              networkRecoveryAttempts += 1
              hls.startLoad()
              return
            }
            break
          case Hls.ErrorTypes.MEDIA_ERROR:
            if (mediaRecoveryAttempts < 2) {
              mediaRecoveryAttempts += 1
              sourceChangingRef.current = true
              hls.recoverMediaError()
              return
            }
            if (tryCompatibilityPlayback(q, codec)) return
            break
        }

        sourceChangingRef.current = true
        stopCurrentSession()
        hls.destroy()
        hlsRef.current = null
        usePlayerStore.getState().setPlaying(false)
        setError(`재생에 실패했습니다. ${detail}`)
      })
      if (autoPlay) {
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (startRequestSeqRef.current === requestSeq && playbackIntentRef.current) videoEl.play().catch(() => {})
        })
      }
      hls.loadSource(getHLSUrl(filePath, sid, q, startTime, codec, storeAudioTrack, attempt.acceleration))
      hls.attachMedia(videoEl)
      setUseHLS(true)
    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      const url = getHLSUrl(filePath, sid, q, startTime, codec, storeAudioTrack, attempt.acceleration)
      fetch(url, { headers: { Authorization: `Bearer ${getStoredAuthToken()}` } }).then(response => {
        if (startRequestSeqRef.current !== requestSeq) return
        if (!response.ok) throw new Error('재생 준비 실패')
        const header = response.headers.get('X-Media-Time-Origin')
        hlsStartTimeRef.current = header !== null && Number.isFinite(Number(header)) ? Number(header) : startTime
        videoEl.addEventListener('loadedmetadata', () => {
          if (startRequestSeqRef.current !== requestSeq) return
          videoEl.currentTime = Math.max(0, startTime-hlsStartTimeRef.current)
          videoEl.playbackRate = usePlayerStore.getState().playbackRate
          if (playbackIntentRef.current) videoEl.play().catch(() => {})
          else pauseSession(sid).catch(() => {})
        }, { once: true })
        videoEl.src = url
        setUseHLS(true)
      }).catch(() => {
        if (startRequestSeqRef.current === requestSeq && !tryCompatibilityPlayback(q, codec, 'server')) setError('재생 목록을 준비하지 못했습니다.')
      })
    } else {
      stopCurrentSession()
      setError('이 브라우저는 HLS 재생을 지원하지 않습니다.')
    }
  }, [startHeartbeat, stopCurrentSession, tryCompatibilityPlayback])

  // Seek to absolute time. If beyond buffered range in HLS, restart transcoding.
  const seek = useCallback((absTime: number) => {
    const video = videoRef.current
    if (!video) return

    const fullDur = probeDurationRef.current || duration
    const clampedTime = Math.max(0, Math.min(absTime, fullDur))
    setEnded(false)
    // 탐색 직후 디코딩이 실패해도 이전 위치가 아닌 사용자가 고른 위치에서 복구한다.
    absTimeRef.current = clampedTime
    setCurrentTime(clampedTime)

    // For direct play (not HLS), just seek directly
    if (!useHLS) {
      video.currentTime = clampedTime
      return
    }

    // Calculate the relative time within the current HLS session
    const relativeTime = clampedTime - hlsStartTimeRef.current

    // 아직 없는 구간으로 currentTime을 옮기면 브라우저가 버퍼 끝으로 잘라
    // 요청 위치를 잃을 수 있다. 실제로 확보한 구간만 내부 탐색한다.
    for (let i = 0; i < video.buffered.length; i++) {
      if (relativeTime >= video.buffered.start(i) && relativeTime < video.buffered.end(i)-0.05) {
        video.currentTime = relativeTime
        return
      }
    }

    // Beyond the buffered range: restart HLS from the new position
    const wasPlaying = playbackIntentRef.current
    startHLS(video, path, quality === 'original' ? 'passthrough' : quality, clampedTime, wasPlaying)
  }, [path, quality, duration, useHLS, startHLS, setCurrentTime])

  // Reset state and fetch file info when path changes
  useEffect(() => {
    let cancelled = false
    // Reset all player state for new video
    setCurrentTime(0)
    setDuration(0)
    setPlaying(false)
    setResumePosition(null)
    setHasResumed(false)
    setMediaInfo(null)
    setSubtitles([])
    setActiveSubtitle(null)
    usePlayerStore.getState().setSecondarySubtitle(null)
    usePlayerStore.getState().clearABLoop()
    usePlayerStore.getState().setChapters([])
    usePlayerStore.getState().setAudioTrack(0)
    setQualityPresets([])
    usePlayerStore.setState({ negotiatedCodec: null, browserCodecs: null, serverEncoders: [], activeAttempt: null, playbackStatus: null })
    usePlayerStore.getState().setCompatibilityMode(false)
    setCurrentFile(path)
    setPresetsReady(false)
    setEnded(false)
    probeDurationRef.current = 0
    lastSavedTimeRef.current = 0
    hlsStartTimeRef.current = 0
    absTimeRef.current = 0

    // Fetch real duration and media info from FFprobe
    getFileInfo(path)
      .then(({ data }) => {
        if (cancelled) return
        setMediaInfo(data)
        if (data.duration) {
          const dur = parseFloat(data.duration)
          probeDurationRef.current = dur
          setDuration(dur)
        }
        // Set chapters if available
        if (data.chapters && data.chapters.length > 0) {
          usePlayerStore.getState().setChapters(data.chapters)
        }
      })
      .catch(() => { if (!cancelled) setError('영상 정보를 읽지 못했습니다. 파일 상태와 서버 로그를 확인해 주세요.') })

    // Fetch saved watch position for resume
    getWatchPosition(path)
      .then(({ data }) => {
        if (cancelled) return
        if (data.position && data.position > 0) {
          setResumePosition(data.position)
        }
      })
      .catch(() => {})

    return () => { cancelled = true }
  }, [path, setCurrentTime, setDuration, setPlaying, setResumePosition, setHasResumed, setMediaInfo, setSubtitles, setActiveSubtitle, setQualityPresets, setCurrentFile])

  usePlayerSubtitles(path)

  // Fetch quality presets — waits for codec negotiation to complete so that
  // passthrough/original options are correctly generated based on browser capabilities.
  // Without codec info, the backend can't determine if passthrough is safe.
  useEffect(() => {
    if (!path || !negotiatedCodec) return
    let cancelled = false
    setPresetsReady(false)

    const { browserCodecs: bc } = usePlayerStore.getState()
    getPresets(path, negotiatedCodec, bc || undefined)
      .then((res) => {
        if (cancelled) return
        const presets = res.data
        if (presets && presets.length > 0) {
          setPresetsReady(true)
          // Keep all presets - QualitySelector handles disabling original when audio incompatible
          setQualityPresets(presets)
          // 저장한 선택은 유지하고 파일별 대안은 재생 계획에서만 결정한다.
        }
      })
      .catch(() => { if (!cancelled) setError('재생 정보를 불러오지 못했습니다. 화면을 새로고침해 주세요.') })
    return () => { cancelled = true }
  }, [path, negotiatedCodec, setQualityPresets])

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
      const absTime = absTimeRef.current
      const dur = probeDurationRef.current || video.duration
      if (absTime > 0 && dur > 0 && Math.abs(absTime - lastSavedTimeRef.current) > 2) {
        lastSavedTimeRef.current = absTime
        saveWatchPosition(path, absTime, dur).catch(() => {})
      }
    }

    const interval = setInterval(savePosition, POSITION_SAVE_INTERVAL_MS)

    const handlePause = () => savePosition()

    video.addEventListener('pause', handlePause)

    return () => {
      clearInterval(interval)
      video.removeEventListener('pause', handlePause)
      // Save on unmount
      savePosition()
    }
  }, [path])

  useEffect(() => {
    rejectedRef.current.clear()
    usePlayerStore.setState({ compatibilityMode: false })
  }, [path, quality, retryCount])

  // 실패한 방식은 같은 파일/화질에서는 다시 고르지 않는다. 탐색/음성 변경에도 유지한다.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    // Wait for quality presets to load before starting any playback.
    // This prevents direct play with "original" from localStorage before
    // preset validation has a chance to redirect to a compatible quality.
    if (!presetsReady || qualityPresets.length === 0) return

    // Wait for codec negotiation to complete before starting HLS
    // (original quality uses direct play, doesn't need codec negotiation)
    if (quality !== 'original' && !negotiatedCodec) return

    setCurrentFile(path)
    setError(null)
    const state = usePlayerStore.getState()
    if (!state.browserCodecs || !state.mediaInfo) return
    const plan = buildPlaybackPlan(quality, qualityPresets, state.serverEncoders, state.browserCodecs, state.mediaInfo.video_codec, audioTrack)
    planRef.current = plan
    const attempt = plan.find(a => !rejectedRef.current.has(attemptKey(a)))
    if (!attempt) { setError('이 파일에 사용 가능한 재생 방식을 찾지 못했습니다. 서버 인코더와 브라우저 지원을 확인해 주세요.'); return }
    usePlayerStore.setState({ activeAttempt: attempt, playbackStatus: null })

    // Save current absolute time for quality/audio-track switches (not new videos)
    // Use absTimeRef which survives HLS destroy from the cleanup of the previous effect run
    const savedAbsTime = absTimeRef.current
    const wasPlaying = playbackIntentRef.current

    // Cleanup previous HLS instance
    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    // Direct play only when user explicitly selects "original" quality
    if (attempt.acceleration === 'direct') {
      sourceChangingRef.current = true
      // Stop the HLS session on server when switching to original
      stopCurrentSession()
      video.src = getDirectUrl(path)
      setUseHLS(false)
      hlsStartTimeRef.current = 0
      // Seek back if quality switch
      const restorePosition = () => {
        video.playbackRate = usePlayerStore.getState().playbackRate
        if (savedAbsTime > 0) {
          video.currentTime = savedAbsTime
        }
        if (wasPlaying) video.play().catch(() => {})
      }
      video.addEventListener('loadedmetadata', restorePosition, { once: true })
      return () => {
        sourceChangingRef.current = true
        video.removeEventListener('loadedmetadata', restorePosition)
        video.pause()
        video.removeAttribute('src')
        video.load()
      }
    }

    // Use HLS for all transcode qualities
    // For quality switch, start from the saved position
    const effectiveQuality = attempt.quality
    startHLS(video, path, effectiveQuality, savedAbsTime, wasPlaying)

    return () => {
      sourceChangingRef.current = true
      stopCurrentSession()
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
      // Stop session on unmount or when dependencies change (quality switch)
    }
  }, [path, quality, qualityPresets, presetsReady, audioTrack, negotiatedCodec, recoveryStep, retryCount, setCurrentFile, startHLS, stopCurrentSession])

  // Sync volume/muted/playbackRate
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.volume = volume
    video.muted = muted
    video.playbackRate = playbackRate
  }, [volume, muted, playbackRate])

  const handleTimeUpdate = useCallback(() => {
    if (sourceChangingRef.current) return
    const video = videoRef.current
    if (video && !video.error) {
      // Report absolute time (HLS video.currentTime is relative to transcode start)
      const abs = video.currentTime + hlsStartTimeRef.current
      absTimeRef.current = abs
      setCurrentTime(abs)

      // A-B loop enforcement
      const { abLoop } = usePlayerStore.getState()
      if (abLoop.a !== null && abLoop.b !== null && abs >= abLoop.b) {
        seek(abLoop.a)
      }
    }
  }, [setCurrentTime, seek])

  const handleLoadedMetadata = useCallback(() => {
    sourceChangingRef.current = false
    const video = videoRef.current
    if (video && isFinite(video.duration) && video.duration > 0) {
      // For direct play, use the video's reported duration
      // For HLS, prefer FFprobe duration since video.duration only reflects transcoded portion
      if (!useHLS && video.duration > probeDurationRef.current) {
        setDuration(video.duration)
      }
    }
  }, [setDuration, useHLS])

  const handlePlay = useCallback(() => {
    playbackIntentRef.current = true
    setEnded(false)
    setPlaying(true)
    // Resume the frozen FFmpeg process and restart heartbeat
    if (sessionIDRef.current) {
      resumeSession(sessionIDRef.current).catch(() => {})
      startHeartbeat(sessionIDRef.current)
    }
  }, [setPlaying, startHeartbeat])

  const handlePause = useCallback(() => {
    if (sourceChangingRef.current || videoRef.current?.error) return
    playbackIntentRef.current = false
    setPlaying(false)
    // 계산만 일시정지한다. 이미 할당된 GPU 메모리는 작업 종료 시 반환된다.
    if (sessionIDRef.current) {
      pauseSession(sessionIDRef.current).catch(() => {})
    }
    // 일시정지 중에도 서버 실패를 감시한다. 재개 후 60초 주기가 남으면
    // 활성 작업의 45초 만료보다 늦어 작업이 사라질 수 있다.
  }, [setPlaying, stopHeartbeat])

  const handleMediaError = useCallback(() => {
    const mediaError = videoRef.current?.error
    if (!mediaError || (sourceChangingRef.current && !videoRef.current?.currentSrc)) return
    const decodeFailure = mediaError.code === 3 || mediaError.code === 4
    // 브라우저 디코더 오류는 hls.js의 fatal 오류로 전달되지 않을 수도 있다.
    if (hlsRef.current && !decodeFailure) return
    console.warn('[재생 오류]', { session: sessionIDRef.current, quality, mediaCode: mediaError.code })
    if (decodeFailure &&
        tryCompatibilityPlayback(quality, negotiatedCodec || undefined)) return
    sourceChangingRef.current = true
    stopCurrentSession()
    hlsRef.current?.destroy()
    hlsRef.current = null
    setPlaying(false)
    setError(`브라우저에서 영상을 재생하지 못했습니다. media=${mediaError.code}`)
  }, [quality, negotiatedCodec, tryCompatibilityPlayback, stopCurrentSession, setPlaying])

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

  // Touch gesture controls (mobile)
  useEffect(() => {
    const container = containerRef.current
    const video = videoRef.current
    if (!container || !video || !('ontouchstart' in window)) return

    let startX = 0
    let startY = 0
    let direction: 'none' | 'horizontal' | 'vertical' = 'none'
    let startTime = 0
    let pendingTouchSeek: number | null = null
    let startVolume = 0

    const showGesture = (text: string) => {
      setGestureText(text)
      if (gestureTimerRef.current) clearTimeout(gestureTimerRef.current)
      gestureTimerRef.current = setTimeout(() => setGestureText(null), 800)
    }

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      const touch = e.touches[0]
      startX = touch.clientX
      startY = touch.clientY
      direction = 'none'
      pendingTouchSeek = null
      startTime = video.currentTime + hlsStartTimeRef.current
      startVolume = video.volume
    }

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      const touch = e.touches[0]
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY

      // Determine direction after 30px minimum movement
      if (direction === 'none') {
        if (Math.abs(dx) < 30 && Math.abs(dy) < 30) return
        if (Math.abs(dx) > Math.abs(dy) * 1.5) {
          direction = 'horizontal'
        } else if (Math.abs(dy) > Math.abs(dx) * 1.5) {
          direction = 'vertical'
        } else {
          return
        }
      }

      e.preventDefault()

      if (direction === 'horizontal') {
        // Horizontal swipe → seek
        const rect = container.getBoundingClientRect()
        const seekSeconds = (dx / rect.width) * 120 // max 120s for full width
        const absTarget = startTime + seekSeconds
        const sign = seekSeconds >= 0 ? '+' : ''
        showGesture(`${sign}${Math.round(seekSeconds)}s`)
        pendingTouchSeek = absTarget
      } else if (direction === 'vertical') {
        // Vertical swipe on right side → volume
        const rect = container.getBoundingClientRect()
        const isRightSide = startX > rect.left + rect.width / 2
        if (isRightSide) {
          const volDelta = -dy / rect.height
          const newVol = Math.max(0, Math.min(1, startVolume + volDelta))
          video.volume = newVol
          usePlayerStore.getState().setVolume(newVol)
          showGesture(`Vol ${Math.round(newVol * 100)}%`)
        }
      }
    }

    const handleTouchEnd = () => {
      if (pendingTouchSeek !== null) seek(pendingTouchSeek)
      pendingTouchSeek = null
      direction = 'none'
    }

    container.addEventListener('touchstart', handleTouchStart, { passive: true })
    container.addEventListener('touchmove', handleTouchMove, { passive: false })
    container.addEventListener('touchend', handleTouchEnd, { passive: true })

    return () => {
      container.removeEventListener('touchstart', handleTouchStart)
      container.removeEventListener('touchmove', handleTouchMove)
      container.removeEventListener('touchend', handleTouchEnd)
    }
  }, [seek])

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
        case 'p':
        case 'P': {
          // PiP
          if (document.pictureInPictureEnabled) {
            if (document.pictureInPictureElement) {
              document.exitPictureInPicture().catch(() => {})
            } else {
              video.requestPictureInPicture().catch(() => {})
            }
          }
          break
        }
        case 's':
        case 'S': {
          captureScreenshot(video, path, absTime)
          break
        }
        case 'b':
        case 'B': {
          toggleABLoopWithToast(absTime)
          break
        }
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

  return (
    <div
      ref={containerRef}
      className="player-container relative bg-black rounded-lg overflow-hidden h-full group"
    >
      <video
        ref={videoRef}
        className="w-full h-full object-contain cursor-pointer"
        onClick={togglePlay}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onPlay={handlePlay}
        onPause={handlePause}
        onError={handleMediaError}
        onEnded={() => { setEnded(true); setPlaying(false) }}
      />
      {error && (
        <div className="absolute inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/95 p-6 text-center">
          <p className="text-lg text-red-400">재생 오류</p>
          <p className="text-sm text-gray-400">{error}</p>
          <button className="rounded bg-gray-700 px-4 py-2 text-white" onClick={() => {
            if (!mediaInfo || !negotiatedCodec || !presetsReady) { window.location.reload(); return }
            setError(null)
            setRetryCount(n => n + 1)
          }}>다시 시도</button>
        </div>
      )}
      {/* Gesture feedback overlay */}
      {gestureText && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-30">
          <div className="bg-black/70 text-white text-lg font-medium px-4 py-2 rounded-lg">
            {gestureText}
          </div>
        </div>
      )}
      <SubtitleDisplay videoRef={videoRef} path={path} getTime={() => {
        const video = videoRef.current
        return sourceChangingRef.current || !video || video.readyState < 2 ? null : video.currentTime + hlsStartTimeRef.current
      }} />
      <NextEpisodeOverlay path={path} ended={ended} />
      <PlaybackStats videoRef={videoRef} hlsRef={hlsRef} />
      <Controls
        videoRef={videoRef}
        onTogglePlay={togglePlay}
        onSeek={seek}
        onToggleFullscreen={toggleFullscreen}
        filePath={path}
      />
    </div>
  )
}
