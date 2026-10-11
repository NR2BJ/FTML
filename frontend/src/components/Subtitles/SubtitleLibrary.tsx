import { useEffect, useRef, useState } from 'react'
import { listSubtitles, deleteSubtitle, listSubtitleTrash, restoreSubtitle, requestSubtitleDelete, listMyDeleteRequests, type SubtitleEntry, type TrashedSubtitle } from '@/api/subtitle'
import { useAuthStore } from '@/stores/authStore'
import { usePlayerStore } from '@/stores/playerStore'

export default function SubtitleLibrary({ paths, version, initialView = 'saved' }: { paths: string[]; version: string; initialView?: 'saved' | 'trash' }) {
  const role = useAuthStore(s => s.user?.role)
  const [selectedPath, setSelectedPath] = useState(paths[0])
  const path = paths.includes(selectedPath) ? selectedPath : paths[0]
  return <section aria-label="자막 목록과 삭제" className="space-y-3">
    {paths.length > 1 && <label className="block text-sm">관리할 영상
      <select aria-label="관리할 영상" value={path} onChange={e => setSelectedPath(e.target.value)}
        className="mt-1 w-full rounded border border-dark-600 bg-dark-800 p-2">
        {paths.map(p => <option key={p} value={p}>{p}</option>)}
      </select>
    </label>}
    {path && <Library key={`${path}:${role}`} path={path} role={role} version={version} initialView={initialView} />}
  </section>
}

function Library({ path, role, version, initialView }: { path: string; role?: string; version: string; initialView: 'saved' | 'trash' }) {
  const [view, setView] = useState(initialView)
  const [subtitles, setSubtitles] = useState<SubtitleEntry[]>([])
  const [trash, setTrash] = useState<TrashedSubtitle[]>([])
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const alive = useRef(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    const load = async () => {
      if (view === 'trash' && role === 'admin') {
        const { data } = await listSubtitleTrash(path, controller.signal)
        if (!controller.signal.aborted) setTrash(data || [])
      } else {
        const { data } = await listSubtitles(path, controller.signal)
        if (!controller.signal.aborted) setSubtitles(data || [])
      }
    }
    void load().catch(() => {
      if (!controller.signal.aborted) setError('자막 목록을 읽지 못했습니다.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    if (role === 'user') listMyDeleteRequests().then(({ data }) => {
      if (!controller.signal.aborted) setPending(new Set(data.filter(r => r.video_path === path && r.status === 'pending').map(r => r.subtitle_id)))
    }).catch(() => {})
    return () => controller.abort()
  }, [path, revision, version, role, view])

  const change = async (id: string, label: string, restore = false) => {
    if (inFlight.current || (role !== 'admin' && role !== 'user') || (restore && role !== 'admin')) return
    inFlight.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (role === 'admin') {
        if (restore) await restoreSubtitle(path, id)
        else await deleteSubtitle(path, id)
        // 창을 닫거나 다른 영상으로 이동해도 완료된 변경을 재생기에 알린다.
        usePlayerStore.getState().requestSubtitleRefresh(path)
      } else {
        await requestSubtitleDelete(path, { subtitle_id: id, subtitle_label: label, reason: '' })
      }
      if (!alive.current) return
      setNotice(role === 'user' ? '삭제 요청을 보냈습니다.' : restore ? '자막을 복구했습니다.' : '휴지통으로 옮겼습니다. 휴지통에서 복구할 수 있습니다.')
      setRevision(value => value + 1)
    } catch (cause) {
      if (alive.current) setError((cause as { response?: { data?: { error?: string } } }).response?.data?.error || '자막을 변경하지 못했습니다. 다시 시도해 주세요.')
    } finally {
      inFlight.current = false
      if (alive.current) setBusy(false)
    }
  }

  return <>
    {role === 'admin' && <div className="flex gap-2" aria-label="자막 보관 위치">
      {(['saved', 'trash'] as const).map(value => <button key={value} aria-pressed={view === value} onClick={() => { setView(value); setNotice('') }}
        className={`rounded px-3 py-1 text-sm ${view === value ? 'bg-primary-600 text-white' : 'bg-dark-700 text-gray-300'}`}>
        {value === 'saved' ? '저장된 자막' : '휴지통'}
      </button>)}
    </div>}
    <p className="text-xs text-gray-400">{view === 'trash' && role === 'admin'
      ? '이 영상에서 삭제한 자막입니다. 자동으로 비우지 않으며 원래 이름과 형식으로 복구합니다. 같은 이름의 자막은 덮어쓰지 않습니다.'
      : '앱에 저장한 추출·번역·업로드 자막만 휴지통으로 옮깁니다. 내장·외부 자막과 영상 파일은 변경하지 않습니다.'}</p>
    {loading ? <p role="status">자막을 읽는 중…</p> : view === 'trash' && role === 'admin' ? (
      trash.length === 0 ? <p>휴지통이 비어 있습니다.</p> : trash.map(sub => <div key={sub.id} className="flex items-center gap-3 rounded border border-dark-700 bg-dark-800 p-3">
        <div className="min-w-0 flex-1"><p className="break-words text-sm" title={sub.label}>{sub.label || sub.filename}</p>
          <p className="break-all text-xs text-gray-400">{sub.filename} · {new Date(sub.deleted_at).toLocaleString()}</p></div>
        <button disabled={busy} onClick={() => void change(sub.id, sub.label, true)} className="shrink-0 rounded px-2 py-1 text-sm text-primary-400 disabled:opacity-50">복구</button>
      </div>)
    ) : subtitles.length === 0 ? <p>저장된 자막이 없습니다.</p> : subtitles.map(sub => <div key={sub.id} className="flex items-center gap-3 rounded border border-dark-700 bg-dark-800 p-3">
      <div className="min-w-0 flex-1"><p className="break-words text-sm text-gray-300 [overflow-wrap:anywhere]" title={sub.label}>{sub.label}</p>
        <p className="text-xs text-gray-400">{sub.type === 'generated' ? '저장' : sub.type === 'embedded' ? '내장' : '외부'} · {sub.language} · {sub.format}</p></div>
      {sub.type === 'generated' && (role === 'admin' || role === 'user') && <button disabled={busy || pending.has(sub.id)} onClick={() => void change(sub.id, sub.label)}
        className="shrink-0 rounded px-2 py-1 text-xs text-red-400 disabled:opacity-50">
        {role === 'admin' ? '삭제' : pending.has(sub.id) ? '삭제 요청 중' : '삭제 요청'}
      </button>}
    </div>)}
    {notice && <p role="status" className="text-sm text-primary-400">{notice}</p>}
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    <button disabled={busy || loading} onClick={() => setRevision(v => v + 1)} className="text-xs text-primary-400">목록 새로고침</button>
  </>
}
