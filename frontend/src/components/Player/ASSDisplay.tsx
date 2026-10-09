import { useEffect, useRef, RefObject } from 'react'
import type SubtitlesOctopus from 'libass-wasm'
import { getSubtitleFontUrl, getSubtitleFontsUrl, getSubtitleUrl } from '@/api/subtitle'
import { useSubtitleSettings } from '@/stores/subtitleSettingsStore'
import { loadASSRenderer } from '@/utils/assRenderer'

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>
  path: string
  id: string
  getTime: () => number | null
  onFailure: () => void
  revision: unknown
  renderWindow?: Window
}

export default function ASSDisplay({ videoRef, path, id, getTime, onFailure, revision, renderWindow = window }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ getTime, onFailure })
  latest.current = { getTime, onFailure }
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // 종료된 렌더러의 예약된 그리기가 새 자막의 캔버스에 닿지 않게 분리한다.
    const canvas = renderWindow.document.createElement('canvas')
    canvas.setAttribute('aria-label', 'ASS 자막')
    canvas.className = 'absolute pointer-events-none z-40'
    canvas.style.visibility = 'hidden'
    host.appendChild(canvas)
    const controller = new AbortController()
    let renderer: SubtitlesOctopus | undefined
    let frame = 0
    let ready = false
    let failed = false
    let observer: ResizeObserver | undefined
    let lastTime: number | undefined
    let paused: boolean | undefined
    let rate: number | undefined
    let lastWidth = 0, lastHeight = 0
    const timeout = window.setTimeout(fail, 30000)
    function fail() {
      if (controller.signal.aborted || failed) return
      failed = true
      canvas.style.visibility = 'hidden'
      latest.current.onFailure()
    }
    const resize = () => {
      const video = videoRef.current
      if (!video || !canvas || !renderer || !video.videoWidth || !video.videoHeight) return
      const scale = Math.min(video.clientWidth / video.videoWidth, video.clientHeight / video.videoHeight)
      const width = video.videoWidth * scale, height = video.videoHeight * scale
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      canvas.style.left = `${video.offsetLeft + (video.clientWidth-width)/2}px`
      canvas.style.top = `${video.offsetTop + (video.clientHeight-height)/2}px`
      const pixelRatio = Math.min(renderWindow.devicePixelRatio || 1, 2)
      const w = Math.round(width*pixelRatio), h = Math.round(height*pixelRatio)
      if (w > 0 && h > 0 && (w !== lastWidth || h !== lastHeight)) {
        lastWidth = w; lastHeight = h
        renderer.resize(w, h)
      }
    }
    const sync = (force = false) => {
      if (controller.signal.aborted || failed) return
      const raw = latest.current.getTime()
      const time = raw === null ? null : raw + useSubtitleSettings.getState().syncOffset
      const visible = ready && time !== null && Number.isFinite(time) && time >= 0
      canvas.style.visibility = visible ? 'visible' : 'hidden'
      if (!ready || !renderer) return
      if (!visible || time === null) {
        if (paused !== true) renderer.setIsPaused(true)
        paused = true
        lastTime = undefined
        return
      }
      const video = videoRef.current
      const nextPaused = !video || video.paused || video.seeking || video.readyState < 3
      const nextRate = video?.playbackRate || 1
      if (nextRate !== rate) { renderer.setRate(nextRate); rate = nextRate }
      if (nextPaused !== paused) {
        renderer.setIsPaused(nextPaused)
        renderer.setCurrentTime(time)
        paused = nextPaused
        lastTime = time
      } else if (force || lastTime === undefined || (nextPaused ? time !== lastTime : Math.abs(time-lastTime) >= 0.1)) {
        // 재생 중에는 Worker가 30fps로 그린다. 매 화면마다 동기 렌더링을 쌓지 않는다.
        renderer.setCurrentTime(time)
        lastTime = time
      }
    }
    const tick = () => {
      if (controller.signal.aborted || failed) return
      try { sync() } catch { fail(); return }
      frame = renderWindow.requestAnimationFrame(tick)
    }
    const syncNow = () => { try { sync(true) } catch { fail() } }
    const start = async () => {
      const response = await fetch(getSubtitleUrl(path, id, true), { signal: controller.signal, cache: 'no-cache' })
      if (!response.ok) throw new Error('ASS 읽기 실패')
      const content = await response.text()
      if (!/^\s*\[Script Info\]/im.test(content)) throw new Error('ASS 형식 아님')
      const fontResponse = await fetch(getSubtitleFontsUrl(path), { signal: controller.signal })
      const ids: number[] = fontResponse.ok ? await fontResponse.json() : []
      const Renderer = await loadASSRenderer(renderWindow)
      if (controller.signal.aborted) return
      renderer = new Renderer({ canvas, subContent: content,
        workerUrl: new URL('/ass-renderer/4.1.0/subtitles-octopus-worker.js', document.baseURI).href,
        fonts: ids.slice(0, 32).map(font => new URL(getSubtitleFontUrl(path, font), document.baseURI).href),
        fallbackFont: new URL(getSubtitleFontUrl(path, 'default'), document.baseURI).href, targetFps: 30, libassMemoryLimit: 64, libassGlyphLimit: 16,
        onReady: () => {
          if (controller.signal.aborted || failed) return
          ready = true
          window.clearTimeout(timeout)
          syncNow()
          resize()
        }, onError: fail,
      })
      observer = new (renderWindow as Window & typeof globalThis).ResizeObserver(resize)
      if (videoRef.current) { observer.observe(videoRef.current); videoRef.current.addEventListener('loadedmetadata', resize) }
      tick()
    }
    start().catch(error => { if (!controller.signal.aborted) { console.warn('ASS 표시 초기화 실패', error); fail() } })
    const video = videoRef.current
    const events = ['playing', 'pause', 'waiting', 'seeking', 'seeked', 'ratechange', 'timeupdate']
    for (const event of events) video?.addEventListener(event, syncNow)
    renderWindow.document.addEventListener('visibilitychange', syncNow)
    return () => {
      controller.abort()
      window.clearTimeout(timeout)
      renderWindow.cancelAnimationFrame(frame)
      observer?.disconnect()
      video?.removeEventListener('loadedmetadata', resize)
      for (const event of events) video?.removeEventListener(event, syncNow)
      renderWindow.document.removeEventListener('visibilitychange', syncNow)
      canvas.style.visibility = 'hidden'
      canvas.remove()
      // 렌더러는 Worker 오류 시 스스로 종료하므로 두 번째 종료는 실패할 수 있다.
      try { renderer?.dispose() } catch { /* 이미 종료된 Worker */ }
    }
  }, [path, id, videoRef, revision, renderWindow])
  return <div ref={hostRef} className="contents" />
}
