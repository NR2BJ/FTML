import { useEffect, useState } from 'react'
import { listSubtitles, deleteSubtitle, requestSubtitleDelete, listMyDeleteRequests, type SubtitleEntry } from '@/api/subtitle'
import { useAuthStore } from '@/stores/authStore'
import { usePlayerStore } from '@/stores/playerStore'

export default function SubtitleLibrary({ paths, version }: { paths: string[]; version: string }) {
  const role = useAuthStore(s => s.user?.role)
  const [selectedPath, setSelectedPath] = useState(paths[0])
  const path = paths.includes(selectedPath) ? selectedPath : paths[0]
  const [subtitles, setSubtitles] = useState<SubtitleEntry[]>([])
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<SubtitleEntry | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setSubtitles([])
    setConfirm(null)
    setError('')
    setPending(new Set())
    if (!path) { setLoading(false); return () => controller.abort() }
    listSubtitles(path, controller.signal).then(({ data }) => {
      if (!controller.signal.aborted) setSubtitles(data || [])
    }).catch(() => {
      if (!controller.signal.aborted) setError('자막 목록을 읽지 못했습니다.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    if (role === 'user') listMyDeleteRequests().then(({ data }) => {
      if (!controller.signal.aborted) setPending(new Set(data.filter(r => r.video_path === path && r.status === 'pending').map(r => r.subtitle_id)))
    }).catch(() => {})
    return () => controller.abort()
  }, [path, revision, version, role])

  const remove = async () => {
    if (!confirm || busy) return
    setBusy(true)
    setError('')
    try {
      if (role === 'admin') {
        await deleteSubtitle(path, confirm.id)
        usePlayerStore.getState().requestSubtitleRefresh(path)
      } else if (role === 'user') {
        await requestSubtitleDelete(path, { subtitle_id: confirm.id, subtitle_label: confirm.label, reason: '' })
      } else return
      setConfirm(null)
      setRevision(value => value + 1)
    } catch {
      setError('자막을 삭제하거나 삭제 요청을 보내지 못했습니다. 다시 시도해 주세요.')
    } finally { setBusy(false) }
  }

  return <section aria-label="자막 목록과 삭제" className="space-y-3">
    {paths.length > 1 && <label className="block text-sm">관리할 영상
      <select aria-label="관리할 영상" disabled={busy} value={path} onChange={e => setSelectedPath(e.target.value)}
        className="mt-1 w-full rounded border border-dark-600 bg-dark-800 p-2">
        {paths.map(p => <option key={p} value={p}>{p}</option>)}
      </select>
    </label>}
    <p className="text-xs text-gray-400">앱에 저장한 추출·번역·업로드 자막만 삭제할 수 있습니다. 영상에 내장되거나 미디어 폴더에 있는 외부 자막은 변경하지 않습니다.</p>
    {loading ? <p role="status">자막을 읽는 중…</p> : subtitles.length === 0 ? <p>저장된 자막이 없습니다.</p> : subtitles.map(sub =>
      <div key={sub.id} className="flex items-center gap-3 rounded border border-dark-700 bg-dark-800 p-3">
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm text-gray-300 [overflow-wrap:anywhere]" title={sub.label}>{sub.label}</p>
          <p className="text-xs text-gray-400">{sub.type === 'generated' ? '저장' : sub.type === 'embedded' ? '내장' : '외부'} · {sub.language} · {sub.format}</p>
        </div>
        {sub.type === 'generated' && (role === 'admin' || role === 'user') && (
          <button disabled={busy || pending.has(sub.id)} onClick={() => setConfirm(sub)}
            className="shrink-0 rounded px-2 py-1 text-xs text-red-400 disabled:opacity-50">
            {role === 'admin' ? '삭제' : pending.has(sub.id) ? '삭제 요청 중' : '삭제 요청'}
          </button>
        )}
      </div>
    )}
    {confirm && <div role="alert" className="rounded border border-red-400 p-3 text-sm">
      <p className="break-words">‘{confirm.label}’ {role === 'admin' ? '자막을 삭제할까요?' : '자막 삭제를 요청할까요?'}</p>
      <div className="mt-2 flex justify-end gap-3">
        <button disabled={busy} onClick={() => setConfirm(null)}>취소</button>
        <button disabled={busy} onClick={() => void remove()} className="text-red-400">{busy ? '처리 중…' : '확인'}</button>
      </div>
    </div>}
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    <button disabled={busy || loading} onClick={() => setRevision(v => v + 1)} className="text-xs text-primary-400">목록 새로고침</button>
  </section>
}
