import { useEffect, useState, useRef, RefObject } from 'react'
import Hls from 'hls.js'
import { usePlayerStore } from '@/stores/playerStore'
import { formatDuration } from '@/utils/format'

interface PlaybackStatsProps {
  videoRef: RefObject<HTMLVideoElement | null>
  hlsRef: RefObject<Hls | null>
}

interface RuntimeStats {
  playResolution: string
  playBitrate: number
  playFramerate: number
  bufferLength: number
  droppedFrames: number
  totalFrames: number
  bandwidth: number
}

export default function PlaybackStats({ videoRef, hlsRef }: PlaybackStatsProps) {
  const { showStats, mediaInfo, currentTime, duration, quality, negotiatedCodec, negotiatedEncoder, hwaccel } = usePlayerStore()
  const [stats, setStats] = useState<RuntimeStats>({
    playResolution: '',
    playBitrate: 0,
    playFramerate: 0,
    bufferLength: 0,
    droppedFrames: 0,
    totalFrames: 0,
    bandwidth: 0,
  })
  const segmentHistoryRef = useRef<Array<{ bytes: number; duration: number; time: number }>>([])
  const attachedHlsRef = useRef<Hls | null>(null)

  useEffect(() => {
    if (!showStats) return

    const onFragLoaded = (_: string, data: any) => {
      const fragStats = data?.frag?.stats
      if (fragStats) {
        const bytes = fragStats.total || fragStats.loaded || 0
        const fragDuration = data?.frag?.duration || 0
        if (bytes > 0 && fragDuration > 0) {
          segmentHistoryRef.current.push({ bytes, duration: fragDuration, time: Date.now() })
          const cutoff = Date.now() - 30000
          segmentHistoryRef.current = segmentHistoryRef.current.filter(s => s.time > cutoff)
        }
      }
    }

    const interval = setInterval(() => {
      const video = videoRef.current
      const hls = hlsRef.current
      if (!video) return

      // Attach FRAG_LOADED listener if hls instance changed
      if (hls && hls !== attachedHlsRef.current) {
        if (attachedHlsRef.current) {
          attachedHlsRef.current.off(Hls.Events.FRAG_LOADED, onFragLoaded)
        }
        hls.on(Hls.Events.FRAG_LOADED, onFragLoaded)
        attachedHlsRef.current = hls
        segmentHistoryRef.current = []
      } else if (!hls && attachedHlsRef.current) {
        attachedHlsRef.current.off(Hls.Events.FRAG_LOADED, onFragLoaded)
        attachedHlsRef.current = null
        segmentHistoryRef.current = []
      }

      // Buffer length
      let bufferLength = 0
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) {
          bufferLength = video.buffered.end(i) - video.currentTime
          break
        }
      }

      // Dropped frames
      const playQuality = (video as any).getVideoPlaybackQuality?.()
      const droppedFrames = playQuality?.droppedVideoFrames || 0
      const totalFrames = playQuality?.totalVideoFrames || 0

      // Live resolution from video element
      const playResolution = video.videoWidth && video.videoHeight
        ? `${video.videoWidth}x${video.videoHeight}`
        : ''

      // Framerate from decoded frames / time
      const playFramerate = totalFrames > 0 && video.currentTime > 1
        ? Math.round(totalFrames / video.currentTime)
        : 0

      let playBitrate = 0
      let bandwidth = 0

      if (hls) {
        // HLS mode: bitrate from segment sizes, bandwidth from hls.js
        const history = segmentHistoryRef.current
        if (history.length > 0) {
          const totalBytes = history.reduce((sum, s) => sum + s.bytes, 0)
          const totalDuration = history.reduce((sum, s) => sum + s.duration, 0)
          if (totalDuration > 0) {
            playBitrate = (totalBytes * 8) / totalDuration
          }
        }
        bandwidth = hls.bandwidthEstimate || 0
      } else {
        // Direct play mode: estimate bitrate from buffered growth
        // Use mozDecodedBytes (Firefox) or estimate from buffered time * source bitrate
        const mozBytes = (video as any).mozDecodedBytes
        if (mozBytes && mozBytes > 0 && video.currentTime > 1) {
          playBitrate = (mozBytes * 8) / video.currentTime
        } else {
          // Fallback: use FFprobe format bitrate as the file's average bitrate
          const formatBr = parseFloat(mediaInfo?.bit_rate || '0')
          if (formatBr > 0) {
            playBitrate = formatBr
          }
        }
      }

      setStats({
        playResolution,
        playBitrate,
        playFramerate,
        bufferLength,
        droppedFrames,
        totalFrames,
        bandwidth,
      })
    }, 1000)

    return () => {
      clearInterval(interval)
      if (attachedHlsRef.current) {
        attachedHlsRef.current.off(Hls.Events.FRAG_LOADED, onFragLoaded)
        attachedHlsRef.current = null
      }
    }
  }, [showStats, videoRef, hlsRef, mediaInfo])

  if (!showStats) return null

  const fmtBitrate = (bps: number) => {
    if (!bps || isNaN(bps)) return 'N/A'
    if (bps >= 1000000) return `${(bps / 1000000).toFixed(1)} Mbps`
    if (bps >= 1000) return `${(bps / 1000).toFixed(0)} kbps`
    return `${bps} bps`
  }

  const srcCodec = mediaInfo?.video_codec || 'N/A'
  const srcResolution = mediaInfo?.width && mediaInfo?.height
    ? `${mediaInfo.width}x${mediaInfo.height}`
    : 'N/A'
  const audioStream = mediaInfo?.streams?.find((s: any) => s.codec_type === 'audio')
  const isOriginal = quality === 'original'
  const isHLS = !!hlsRef.current

  return (
    <div className="absolute top-4 left-4 z-50 bg-black/80 text-white text-xs font-mono p-3 rounded-lg select-none pointer-events-none max-w-xs">
      <div className="font-bold text-blue-400 mb-1">Source</div>
      <div className="ml-2 space-y-0.5">
        <div>Video: {srcCodec} {srcResolution}</div>
        <div>Audio: {mediaInfo?.audio_codec || 'N/A'}{audioStream?.channels ? ` ${audioStream.channels}ch` : ''}{audioStream?.sample_rate ? ` ${audioStream.sample_rate}Hz` : ''}</div>
      </div>

      <div className="font-bold text-green-400 mt-2 mb-1">Playback{isOriginal ? ' (Direct)' : ' (Transcode)'}</div>
      <div className="ml-2 space-y-0.5">
        <div>Resolution: {stats.playResolution || 'N/A'}</div>
        {!isOriginal && (
          <>
            <div>Codec: {(negotiatedCodec || 'h264').toUpperCase()} + AAC</div>
            <div>Encoder: {negotiatedEncoder || 'N/A'}{hwaccel && hwaccel !== 'none' ? ` (${hwaccel})` : ''}</div>
          </>
        )}
        <div>Bitrate: {fmtBitrate(stats.playBitrate)}{isOriginal && stats.playBitrate > 0 ? ' (avg)' : ''}</div>
        <div>Framerate: {stats.playFramerate > 0 ? `${stats.playFramerate} fps` : 'N/A'}</div>
      </div>

      <div className="font-bold text-yellow-400 mt-2 mb-1">Network</div>
      <div className="ml-2 space-y-0.5">
        <div>Buffer: {stats.bufferLength.toFixed(1)}s</div>
        <div>Dropped: {stats.droppedFrames}{stats.totalFrames ? ` / ${stats.totalFrames}` : ''}</div>
        {isHLS && <div>Delivery: {fmtBitrate(stats.bandwidth)}</div>}
      </div>

      <div className="font-bold text-purple-400 mt-2 mb-1">Position</div>
      <div className="ml-2">
        <div>{formatDuration(currentTime)} / {formatDuration(duration)}</div>
      </div>
    </div>
  )
}
