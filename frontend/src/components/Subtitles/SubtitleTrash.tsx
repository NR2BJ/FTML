import { useEffect, useRef, useState } from 'react'
import { listSubtitleTrash, restoreSubtitle, type TrashedSubtitle } from '@/api/subtitle'
import { usePlayerStore } from '@/stores/playerStore'

export default function SubtitleTrash() {
  const [entries, setEntries] = useState<TrashedSubtitle[]>([])
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const inFlight = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    listSubtitleTrash(controller.signal).then(({ data }) => {
      if (!controller.signal.aborted) setEntries(data)
    }).catch(() => {
      if (!controller.signal.aborted) setError('휴지통 목록을 읽지 못했습니다.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision])

  const restore = async (entry: TrashedSubtitle) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { data } = await restoreSubtitle(entry.storage_key, entry.id)
      const path = entry.video_path || data.video_path
      if (path) usePlayerStore.getState().requestSubtitleRefresh(path)
      if (!alive.current) return
      setNotice('원래 위치에 자막을 복구했습니다.')
      setRevision(value => value + 1)
    } catch (cause) {
      if (alive.current) setError((cause as { response?: { data?: { error?: string } } }).response?.data?.error || '자막을 복구하지 못했습니다. 목록을 새로고침해 주세요.')
    } finally {
      inFlight.current = false
      if (alive.current) setBusy(false)
    }
  }

  const filtered = entries.filter(entry => `${entry.video_path || ''} ${entry.label} ${entry.filename} ${entry.storage_key}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return <section aria-label="전체 자막 휴지통" className="my-6 space-y-3">
    <h2 className="text-sm font-medium text-gray-300">자막 휴지통 · 모든 영상</h2>
    <p className="text-xs text-gray-400">원래 이름과 형식으로 복구합니다. 같은 이름의 자막은 덮어쓰지 않습니다. 자동 비우기로 영구 삭제된 자막은 복구할 수 없습니다.</p>
    <input aria-label="휴지통 검색" placeholder="영상 경로 또는 자막 이름 검색" value={query} onChange={e => setQuery(e.target.value)} className="w-full rounded border border-dark-600 bg-dark-800 p-2 text-sm text-gray-200" />
    {loading ? <p role="status">휴지통을 읽는 중…</p> : <>
      <p className="text-xs text-gray-400">{filtered.length}개 / 전체 {entries.length}개</p>
      {filtered.length === 0 ? <p className="text-sm text-gray-400">표시할 자막이 없습니다.</p> : <div className="max-h-96 overflow-y-auto space-y-2">
        {filtered.map(entry => <div key={`${entry.storage_key}:${entry.id}`} className="flex items-center gap-3 rounded border border-dark-700 bg-dark-900 p-3">
          <div className="min-w-0 flex-1">
            <p className="break-all text-xs text-gray-400">{entry.video_path || `영상 경로 정보 없음 · ${entry.storage_key}`}</p>
            <p className="break-words text-sm text-gray-200">{entry.label || entry.filename}</p>
            <p className="break-all text-xs text-gray-400">{entry.filename} · 삭제 {new Date(entry.deleted_at).toLocaleString()}</p>
          </div>
          <button disabled={busy} onClick={() => void restore(entry)} className="shrink-0 rounded px-2 py-1 text-sm text-primary-400 disabled:opacity-50">복구</button>
        </div>)}
      </div>}
    </>}
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    {notice && <p role="status" className="text-sm text-primary-400">{notice}</p>}
    <button disabled={loading || busy} onClick={() => setRevision(value => value + 1)} className="text-sm text-primary-400">휴지통 새로고침</button>
  </section>
}
