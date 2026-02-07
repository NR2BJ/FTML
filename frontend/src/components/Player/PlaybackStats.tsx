import { useEffect, useState, useRef, RefObject } from 'react'
import Hls from 'hls.js'
import { usePlayerStore } from '@/stores/playerStore'
import { formatDuration } from '@/utils/format'

interface PlaybackStatsProps {
  videoRef: RefObject<HTMLVideoElement | null>
  hlsRef: RefObject<Hls | null>
}

interface RuntimeStats {
  bufferLength: number
  droppedFrames: number
  totalFrames: number
  downloadSpeed: number
}

export default function PlaybackStats({ videoRef, hlsRef }: PlaybackStatsProps) {
  const { showStats, mediaInfo, currentTime, duration } = usePlayerStore()
  const [stats, setStats] = useState<RuntimeStats>({
    bufferLength: 0,
    droppedFrames: 0,
    totalFrames: 0,
    downloadSpeed: 0,
  })
  const prevLoadedRef = useRef<number>(0)
  const prevTimeRef = useRef<number>(Date.now())

  useEffect(() => {
    if (!showStats) return

    // Reset throughput tracking when stats are toggled on
    prevLoadedRef.current = 0
    prevTimeRef.current = Date.now()

    const interval = setInterval(() => {
      const video = videoRef.current
      if (!video) return

      // Buffer length
      let bufferLength = 0
      let totalLoaded = 0
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) {
          bufferLength = video.buffered.end(i) - video.currentTime
        }
        totalLoaded += video.buffered.end(i) - video.buffered.start(i)
      }

      // Dropped frames
      const quality = (video as any).getVideoPlaybackQuality?.()
      const droppedFrames = quality?.droppedVideoFrames || 0
      const totalFrames = quality?.totalVideoFrames || 0

      // Actual download throughput estimate
      // Use buffered time growth * bitrate to approximate actual throughput
      const now = Date.now()
      const elapsed = (now - prevTimeRef.current) / 1000
      let downloadSpeed = 0
      if (elapsed > 0 && prevLoadedRef.current > 0) {
        const loadedDelta = totalLoaded - prevLoadedRef.current
        if (loadedDelta > 0) {
          // Convert seconds of buffered content to bits using format bitrate
          const formatBitrate = parseFloat(mediaInfo?.bit_rate || '0')
          if (formatBitrate > 0) {
            downloadSpeed = (loadedDelta / elapsed) * formatBitrate
          }
        }
      }
      prevLoadedRef.current = totalLoaded
      prevTimeRef.current = now

      setStats({ bufferLength, droppedFrames, totalFrames, downloadSpeed })
    }, 1000)

    return () => clearInterval(interval)
  }, [showStats, videoRef, hlsRef, mediaInfo])

  if (!showStats) return null

  const formatBitrate = (bps: string | number) => {
    const n = typeof bps === 'string' ? parseFloat(bps) : bps
    if (!n || isNaN(n)) return 'N/A'
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)} Mbps`
    if (n >= 1000) return `${(n / 1000).toFixed(0)} kbps`
    return `${n} bps`
  }

  const formatSpeed = (bps: number) => {
    if (!bps) return 'N/A'
    return `${(bps / 1000000).toFixed(1)} Mbps`
  }

  // Find audio stream details from mediaInfo
  const audioStream = mediaInfo?.streams?.find((s: any) => s.codec_type === 'audio')
  const videoStream = mediaInfo?.streams?.find((s: any) => s.codec_type === 'video')

  // Estimate audio bitrate: use stream bitrate, or derive from format bitrate - video bitrate
  const getAudioBitrate = () => {
    if (audioStream?.bit_rate) return audioStream.bit_rate
    // Fallback: format bitrate minus video bitrate
    const formatBr = parseFloat(mediaInfo?.bit_rate || '0')
    const videoBr = parseFloat(videoStream?.bit_rate || '0')
    if (formatBr > 0 && videoBr > 0) {
      return String(formatBr - videoBr)
    }
    // Last fallback: estimate from file size and duration
    if (mediaInfo?.size && mediaInfo?.duration && formatBr > 0 && videoBr === 0) {
      // If we don't have video bitrate either, just show format bitrate as total
      return null
    }
    return null
  }
  const audioBitrate = getAudioBitrate()

  return (
    <div className="absolute top-4 left-4 z-50 bg-black/80 text-white text-xs font-mono p-3 rounded-lg select-none pointer-events-none max-w-xs">
      <div className="font-bold text-blue-400 mb-1">Video</div>
      <div className="ml-2 space-y-0.5">
        <div>Codec: {mediaInfo?.video_codec || 'N/A'} &rarr; h264 (transcode)</div>
        <div>Resolution: {mediaInfo?.width && mediaInfo?.height ? `${mediaInfo.width}x${mediaInfo.height}` : 'N/A'}</div>
        <div>Bitrate: {formatBitrate(mediaInfo?.bit_rate || '')}</div>
        <div>Framerate: {videoStream?.r_frame_rate || mediaInfo?.frame_rate || 'N/A'}</div>
      </div>

      <div className="font-bold text-green-400 mt-2 mb-1">Audio</div>
      <div className="ml-2 space-y-0.5">
        <div>Codec: {mediaInfo?.audio_codec || 'N/A'}</div>
        <div>Bitrate: {audioBitrate ? formatBitrate(audioBitrate) : (mediaInfo?.audio_codec === 'flac' ? 'Lossless' : 'N/A')}</div>
        <div>Channels: {audioStream?.channels || 'N/A'}</div>
        <div>Sample Rate: {audioStream?.sample_rate ? `${audioStream.sample_rate} Hz` : 'N/A'}</div>
      </div>

      <div className="font-bold text-yellow-400 mt-2 mb-1">Network</div>
      <div className="ml-2 space-y-0.5">
        <div>Buffer: {stats.bufferLength.toFixed(1)}s</div>
        <div>Dropped Frames: {stats.droppedFrames}{stats.totalFrames ? ` / ${stats.totalFrames}` : ''}</div>
        <div>Throughput: {formatSpeed(stats.downloadSpeed)}</div>
      </div>

      <div className="font-bold text-purple-400 mt-2 mb-1">Playback</div>
      <div className="ml-2 space-y-0.5">
        <div>Current Time: {formatDuration(currentTime)}</div>
        <div>Duration: {formatDuration(duration)}</div>
      </div>
    </div>
  )
}
