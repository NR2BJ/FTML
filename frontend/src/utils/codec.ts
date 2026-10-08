import type { MediaInfo } from '@/api/files'

export interface BrowserCodecSupport {
  // Video
  h264: boolean
  hevc: boolean
  hevc10: boolean
  av1: boolean
  vp9: boolean
  // Audio
  aac: boolean
  opus: boolean
  flac: boolean
  ac3: boolean
}

// 브라우저 이름 대신 해당 파일의 해상도/프레임/프로필을 검사한다.
// API 미지원이나 시간 초과는 '미확인'으로 두고 실제 재생 감시가 최종 판단한다.
export async function detectMediaCodecs(info: MediaInfo): Promise<BrowserCodecSupport> {
  const support = detectBrowserCodecs()
  const stream = info.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const [n, d = '1'] = (info.frame_rate || '24/1').split('/')
  const framerate = Number(n) / Number(d) || 24
  const level = Number(stream?.level)
  const codecs = {
    h264: info.video_codec === 'h264' && level > 0 ? `avc1.${stream?.profile === 'Main' ? '4d' : /Baseline/.test(stream?.profile || '') ? '42' : '64'}00${level.toString(16).padStart(2, '0')}` : 'avc1.640028',
    hevc: `hvc1.1.6.L${info.video_codec === 'hevc' && level > 0 ? level : 153}.B0`,
    hevc10: `hvc1.2.4.L${info.video_codec === 'hevc' && level > 0 ? level : 153}.B0`,
    av1: 'av01.0.08M.08',
    vp9: 'vp09.00.10.08',
  }
  const keys = Object.keys(codecs) as Array<keyof typeof codecs>
  await Promise.all(keys.map(async key => {
    if (!support[key]) return
    const contentType = `video/mp4; codecs="${codecs[key]}"`
    if (typeof MediaSource !== 'undefined' && !MediaSource.isTypeSupported(contentType)) { support[key] = false; return }
    if (!navigator.mediaCapabilities?.decodingInfo) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const answer = await Promise.race([
        navigator.mediaCapabilities.decodingInfo({ type: 'media-source', video: {
          contentType, width: info.width || 1920, height: info.height || 1080,
          bitrate: Math.max(1, Number(info.bit_rate) || 8_000_000), framerate,
        } }),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1800) }),
      ])
      if (answer && (!answer.supported || !answer.smooth)) support[key] = false
    } catch { /* 미지원 질의는 MSE 결과를 유지한다. */ }
    finally { clearTimeout(timer) }
  }))
  // 10비트 AV1/VP9는 별도 프로필 질의가 필요하므로 원본 후보에서 보수적으로 제외한다.
  return support
}

/**
 * Detect which video and audio codecs the browser can decode.
 * Uses MediaSource.isTypeSupported() for MSE-based playback (hls.js),
 * falls back to HTMLVideoElement.canPlayType() for direct play.
 */
export function detectBrowserCodecs(): BrowserCodecSupport {
  const checkMSE = (mime: string): boolean => {
    try {
      if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported) {
        return MediaSource.isTypeSupported(mime)
      }
    } catch {
      // Ignore errors
    }
    return false
  }

  const checkVideo = (mime: string): boolean => {
    try {
      const v = document.createElement('video')
      const result = v.canPlayType(mime)
      return result === 'probably' || result === 'maybe'
    } catch {
      return false
    }
  }

  // HLS uses MSE when available; direct-play support cannot substitute for it.
  const check = (mime: string): boolean =>
    typeof MediaSource !== 'undefined' ? checkMSE(mime) : checkVideo(mime)

  return {
    // Video codecs
    h264: check('video/mp4; codecs="avc1.640028"'),
    // FFmpeg emits hvc1. Main and Main 10 support must be checked separately.
    hevc: check('video/mp4; codecs="hvc1.1.6.L93.B0"'),
    hevc10: check('video/mp4; codecs="hvc1.2.4.L120.B0"'),
    av1: check('video/mp4; codecs="av01.0.08M.08"'),
    vp9: check('video/mp4; codecs="vp09.00.10.08"'),
    // Audio codecs
    aac: check('audio/mp4; codecs="mp4a.40.2"'),
    opus: check('audio/webm; codecs="opus"') || checkVideo('audio/ogg; codecs="opus"'),
    flac: checkVideo('audio/flac') || checkVideo('audio/x-flac'),
    ac3: check('audio/mp4; codecs="ac-3"'),
  }
}
