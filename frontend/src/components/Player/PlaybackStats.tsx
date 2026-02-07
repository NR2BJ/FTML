import { useEffect, useState, RefObject } from 'react'
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

  useEffect(() => {
    if (!showStats) return

    const interval = setInterval(() => {
      const video = videoRef.current
      if (!video) return

      // Buffer length
      let bufferLength = 0
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) {
          bufferLength = video.buffered.end(i) - video.currentTime
          break
        }
      }

      // Dropped frames
      const quality = (video as any).getVideoPlaybackQuality?.()
      const droppedFrames = quality?.droppedVideoFrames || 0
      const totalFrames = quality?.totalVideoFrames || 0

      // Download speed from hls.js
      const downloadSpeed = hlsRef.current?.bandwidthEstimate || 0

      setStats({ bufferLength, droppedFrames, totalFrames, downloadSpeed })
    }, 1000)

    return () => clearInterval(interval)
  }, [showStats, videoRef, hlsRef])

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
        <div>Bitrate: {audioStream?.bit_rate ? formatBitrate(audioStream.bit_rate) : 'N/A'}</div>
        <div>Channels: {audioStream?.channels || 'N/A'}</div>
        <div>Sample Rate: {audioStream?.sample_rate ? `${audioStream.sample_rate} Hz` : 'N/A'}</div>
      </div>

      <div className="font-bold text-yellow-400 mt-2 mb-1">Network</div>
      <div className="ml-2 space-y-0.5">
        <div>Buffer: {stats.bufferLength.toFixed(1)}s</div>
        <div>Dropped Frames: {stats.droppedFrames}{stats.totalFrames ? ` / ${stats.totalFrames}` : ''}</div>
        <div>Download Speed: {formatSpeed(stats.downloadSpeed)}</div>
      </div>

      <div className="font-bold text-purple-400 mt-2 mb-1">Playback</div>
      <div className="ml-2 space-y-0.5">
        <div>Current Time: {formatDuration(currentTime)}</div>
        <div>Duration: {formatDuration(duration)}</div>
      </div>
    </div>
  )
}
