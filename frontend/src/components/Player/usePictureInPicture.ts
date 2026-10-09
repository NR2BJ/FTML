import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useToastStore } from '@/stores/toastStore'

export function usePictureInPicture(
  path: string,
  videoRef: RefObject<HTMLVideoElement | null>,
) {
  const dockRef = useRef<HTMLDivElement>(null)
  // 같은 포털을 옮겨야 영상/HLS를 다시 만들지 않고 React 조작도 유지할 수 있다.
  const [host] = useState(() => {
    const node = document.createElement('div')
    node.className = 'h-full w-full'
    return node
  })
  const [pipWindow, setPipWindow] = useState<Window | null>(null)
  const current = useRef<Window | null>(null)
  const restore = useRef<() => void>(() => {})
  const generation = useRef(0)
  const opening = useRef(false)
  const supported =
    !!window.documentPictureInPicture || !!document.pictureInPictureEnabled

  useLayoutEffect(() => {
    dockRef.current?.appendChild(host)
    return () => {
      generation.current++
      restore.current()
      host.remove()
    }
  }, [host, path])

  const toggle = async () => {
    if (current.current) {
      restore.current()
      return
    }
    if (opening.current) return
    const video = videoRef.current
    if (!video) return
    opening.current = true
    const version = generation.current
    try {
      if (!window.documentPictureInPicture) {
        if (document.pictureInPictureElement)
          await document.exitPictureInPicture()
        else if (document.pictureInPictureEnabled) {
          await video.requestPictureInPicture()
          useToastStore.getState().addToast({
            type: 'info',
            message:
              '기본 PiP의 자막 지원은 브라우저에 따라 다릅니다. ASS 효과는 자막 포함 PiP를 지원하는 브라우저에서 표시됩니다.',
          })
        } else {
          useToastStore.getState().addToast({
            type: 'info',
            message:
              '브라우저 자체의 PiP 버튼을 사용해 주세요. 지원되는 환경에서는 선택한 자막을 일반 자막으로 전달합니다.',
          })
        }
        return
      }
      const pip = await window.documentPictureInPicture.requestWindow({
        width: 800,
        height: 450,
      })
      if (version !== generation.current || !dockRef.current) {
        pip.close()
        return
      }
      current.current = pip
      const cleanup = () => {
        pip.removeEventListener('pagehide', cleanup)
        if (current.current !== pip) return
        current.current = null
        restore.current = () => {}
        themeObserver.disconnect()
        dockRef.current?.appendChild(host)
        setPipWindow(null)
        if (!pip.closed) pip.close()
      }
      const themeObserver = new MutationObserver(() => {
        pip.document.documentElement.className =
          document.documentElement.className
      })
      restore.current = cleanup
      pip.addEventListener('pagehide', cleanup)
      const base = pip.document.createElement('base')
      base.href = document.baseURI
      pip.document.head.appendChild(base)
      pip.document.title = 'FTML · 자막 포함 PiP'
      pip.document.documentElement.className =
        document.documentElement.className
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class'],
      })
      for (const sheet of document.styleSheets) {
        try {
          const style = pip.document.createElement('style')
          style.textContent = Array.from(
            sheet.cssRules,
            (rule) => rule.cssText,
          ).join('\n')
          pip.document.head.appendChild(style)
        } catch {
          if (!sheet.href) continue
          const link = pip.document.createElement('link')
          link.rel = 'stylesheet'
          link.href = sheet.href
          pip.document.head.appendChild(link)
        }
      }
      pip.document.documentElement.style.cssText =
        'height:100%;background:black'
      pip.document.body.style.cssText =
        'margin:0;height:100%;overflow:hidden;background:black'
      pip.document.body.dataset.ftmlPip = 'true'
      if (document.fullscreenElement)
        void document.exitFullscreen().catch(() => {})
      pip.document.body.appendChild(host)
      setPipWindow(pip)
    } catch {
      if (version !== generation.current) return
      restore.current()
      useToastStore.getState().addToast({
        type: 'error',
        message:
          'PiP 창을 열지 못했습니다. HTTPS 접속과 브라우저의 PiP 허용 여부를 확인해 주세요.',
      })
    } finally {
      opening.current = false
    }
  }
  return { dockRef, host, pipWindow, supported, toggle }
}
