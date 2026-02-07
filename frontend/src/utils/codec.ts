// Browser codec detection using MediaSource.isTypeSupported()

export interface BrowserCodecSupport {
  // Video
  h264: boolean
  hevc: boolean
  av1: boolean
  vp9: boolean
  // Audio
  aac: boolean
  opus: boolean
  flac: boolean
  ac3: boolean
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

  const check = (mime: string): boolean => {
    return checkMSE(mime) || checkVideo(mime)
  }

  return {
    // Video codecs
    h264: check('video/mp4; codecs="avc1.640028"'),
    hevc: check('video/mp4; codecs="hev1.1.6.L93.B0"'),
    av1: check('video/mp4; codecs="av01.0.08M.08"'),
    vp9: check('video/webm; codecs="vp09.00.10.08"'),
    // Audio codecs
    aac: check('audio/mp4; codecs="mp4a.40.2"'),
    opus: check('audio/webm; codecs="opus"') || checkVideo('audio/ogg; codecs="opus"'),
    flac: checkVideo('audio/flac') || checkVideo('audio/x-flac'),
    ac3: check('audio/mp4; codecs="ac-3"'),
  }
}
