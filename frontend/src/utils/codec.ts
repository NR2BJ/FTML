// Browser codec detection using MediaSource.isTypeSupported()

export interface BrowserCodecSupport {
  h264: boolean
  hevc: boolean
  av1: boolean
  vp9: boolean
}

/**
 * Detect which video codecs the browser can decode.
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
    h264: check('video/mp4; codecs="avc1.640028"'),
    hevc: check('video/mp4; codecs="hev1.1.6.L93.B0"'),
    av1: check('video/mp4; codecs="av01.0.08M.08"'),
    vp9: check('video/webm; codecs="vp09.00.10.08"'),
  }
}
