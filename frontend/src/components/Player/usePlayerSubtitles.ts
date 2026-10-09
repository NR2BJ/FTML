import { useEffect } from 'react'
import { listSubtitles } from '@/api/subtitle'
import { useJobStore } from '@/stores/jobStore'
import { usePlayerStore } from '@/stores/playerStore'

// 목록 갱신은 닫힐 수 있는 생성/번역 창이 아니라 재생기가 소유한다.
export function usePlayerSubtitles(path: string) {
  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    let loading = false
    let pending = false
    let forceReload = false
    let initial = true
    let retry: ReturnType<typeof setTimeout> | undefined
    const completed = new Set<string>()

    const refresh = async (force = false) => {
      if (disposed) return
      pending = true
      forceReload ||= force
      if (loading) return
      loading = true
      clearTimeout(retry)
      try {
        while (pending && !disposed) {
          pending = false
          const reload = forceReload
          forceReload = false
          try {
            const { data } = await listSubtitles(path, controller.signal)
            if (disposed || usePlayerStore.getState().currentFile !== path) return
            // 완료 통지가 요청 도중 왔다면 그보다 앞선 목록은 적용하지 않는다.
            if (pending) { forceReload ||= reload; continue }
            const subs = data || []
            const state = usePlayerStore.getState()
            if (initial || reload || JSON.stringify(subs) !== JSON.stringify(state.subtitles)) {
              state.setSubtitles(subs)
            }
            if (initial && state.subtitleEnabled && !state.activeSubtitle) {
              const target = subs.find(s => s.language === state.preferredSubLang) || subs[0]
              if (target) {
                state.setActiveSubtitle(target.id)
                state.setSubtitleVisible(true)
              }
            }
            initial = false
          } catch {
            if (!disposed) {
              forceReload ||= reload
              retry = setTimeout(() => { void refresh() }, 3000)
            }
            break
          }
        }
      } finally {
        loading = false
      }
    }

    const checkJobs = () => {
      let changed = false
      for (const job of useJobStore.getState().jobs) {
        if (job.file_path !== path || job.status !== 'completed' ||
            (job.type !== 'translate' && job.type !== 'transcribe')) continue
        const key = `${job.id}:${job.completed_at || ''}`
        if (!completed.has(key)) { completed.add(key); changed = true }
      }
      if (changed) void refresh(true)
    }
    const unsubscribeJobs = useJobStore.subscribe((state, previous) => {
      if (state.jobs !== previous.jobs) checkJobs()
    })
    const unsubscribePlayer = usePlayerStore.subscribe((state, previous) => {
      if (state.currentFile === path && state.subtitleRefreshVersion !== previous.subtitleRefreshVersion) {
        void refresh(true)
      }
    })
    const onFocus = () => { void refresh(); void useJobStore.getState().fetchActiveJobs() }
    const onVisibility = () => { if (document.visibilityState === 'visible') onFocus() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    void refresh()
    checkJobs()
    useJobStore.getState().startPolling()
    return () => {
      disposed = true
      controller.abort()
      clearTimeout(retry)
      unsubscribeJobs()
      unsubscribePlayer()
      useJobStore.getState().stopPolling()
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [path])
}
