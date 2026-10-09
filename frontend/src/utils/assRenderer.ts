import type SubtitlesOctopus from 'libass-wasm'

type RendererWindow = Window & { SubtitlesOctopus?: typeof SubtitlesOctopus }
const pending = new WeakMap<Window, Promise<typeof SubtitlesOctopus>>()

export function loadASSRenderer(
  target: Window,
): Promise<typeof SubtitlesOctopus> {
  if (target === window)
    return import('libass-wasm').then((module) => module.default)
  const existing = pending.get(target)
  if (existing) return existing
  // 라이브러리 내부 rAF도 보이는 PiP 창에서 실행해야 원래 탭이 숨겨져도 그린다.
  const promise = new Promise<typeof SubtitlesOctopus>((resolve, reject) => {
    const script = target.document.createElement('script')
    script.src = new URL(
      '/ass-renderer/4.1.0/subtitles-octopus.js',
      document.baseURI,
    ).href
    script.onload = () => {
      const renderer = (target as RendererWindow).SubtitlesOctopus
      if (renderer) resolve(renderer)
      else {
        pending.delete(target)
        script.remove()
        reject(new Error('ASS 표시 모듈을 읽지 못했습니다'))
      }
    }
    script.onerror = () => {
      pending.delete(target)
      script.remove()
      reject(new Error('ASS 표시 모듈 요청 실패'))
    }
    target.document.head.appendChild(script)
  })
  pending.set(target, promise)
  return promise
}
