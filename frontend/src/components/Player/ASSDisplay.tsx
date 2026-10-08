import { useEffect, useRef, RefObject } from 'react'
import type SubtitlesOctopus from 'libass-wasm'
import { getSubtitleFontUrl, getSubtitleFontsUrl, getSubtitleUrl } from '@/api/subtitle'
import { useSubtitleSettings } from '@/stores/subtitleSettingsStore'

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>
  path: string
  id: string
  getTime: () => number | null
  onFailure: () => void
  revision: unknown
}

export default function ASSDisplay({ videoRef, path, id, getTime, onFailure, revision }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const latest = useRef({ getTime, onFailure })
  latest.current = { getTime, onFailure }
  useEffect(() => {
    const controller = new AbortController()
    let renderer: SubtitlesOctopus | undefined
    let frame = 0
    let ready = false
    let failed = false
    let observer: ResizeObserver | undefined
    const timeout = window.setTimeout(fail, 30000)
    function fail() {
      if (controller.signal.aborted || failed) return
      failed = true
      latest.current.onFailure()
    }
    const resize = () => {
      const video = videoRef.current, canvas = canvasRef.current
      if (!video || !canvas || !renderer || !video.videoWidth || !video.videoHeight) return
      const scale = Math.min(video.clientWidth / video.videoWidth, video.clientHeight / video.videoHeight)
      const width = video.videoWidth * scale, height = video.videoHeight * scale
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      canvas.style.left = `${video.offsetLeft + (video.clientWidth-width)/2}px`
      canvas.style.top = `${video.offsetTop + (video.clientHeight-height)/2}px`
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
      renderer.resize(Math.round(width*pixelRatio), Math.round(height*pixelRatio))
    }
    const tick = () => {
      if (controller.signal.aborted || failed) return
      const raw = latest.current.getTime()
      const time = raw === null ? null : raw + useSubtitleSettings.getState().syncOffset
      if (canvasRef.current) canvasRef.current.style.visibility = ready && time !== null && time >= 0 ? 'visible' : 'hidden'
      if (ready && time !== null && time >= 0) renderer?.setCurrentTime(time)
      frame = requestAnimationFrame(tick)
    }
    const start = async () => {
      const response = await fetch(getSubtitleUrl(path, id, true), { signal: controller.signal, cache: 'no-cache' })
      if (!response.ok) throw new Error('ASS 읽기 실패')
      const content = await response.text()
      if (!/^\s*\[Script Info\]/im.test(content)) throw new Error('ASS 형식 아님')
      const fontResponse = await fetch(getSubtitleFontsUrl(path), { signal: controller.signal })
      const ids: number[] = fontResponse.ok ? await fontResponse.json() : []
      const { default: Renderer } = await import('libass-wasm')
      if (controller.signal.aborted || !canvasRef.current) return
      renderer = new Renderer({ canvas: canvasRef.current, subContent: content,
        workerUrl: '/ass-renderer/4.1.0/subtitles-octopus-worker.js',
        fonts: ids.slice(0, 32).map(font => getSubtitleFontUrl(path, font)),
        fallbackFont: getSubtitleFontUrl(path, 'default'), targetFps: 30, libassMemoryLimit: 64, libassGlyphLimit: 16,
        onReady: () => { ready = true; window.clearTimeout(timeout); resize() }, onError: fail,
      })
      observer = new ResizeObserver(resize)
      if (videoRef.current) { observer.observe(videoRef.current); videoRef.current.addEventListener('loadedmetadata', resize) }
      tick()
    }
    start().catch(error => { if (!controller.signal.aborted) { console.warn('ASS 표시 초기화 실패', error); fail() } })
    const video = videoRef.current
    return () => {
      controller.abort()
      window.clearTimeout(timeout)
      cancelAnimationFrame(frame)
      observer?.disconnect()
      video?.removeEventListener('loadedmetadata', resize)
      // 렌더러는 Worker 오류 시 스스로 종료하므로 두 번째 종료는 실패할 수 있다.
      try { renderer?.dispose() } catch { /* 이미 종료된 Worker */ }
    }
  }, [path, id, videoRef, revision])
  return <canvas ref={canvasRef} aria-label="ASS 자막" className="absolute pointer-events-none z-40" style={{ visibility: 'hidden' }} />
}
