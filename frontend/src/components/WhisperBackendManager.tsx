import { useState, useEffect } from 'react'
import { listWhisperBackends, createWhisperBackend, updateWhisperBackend, deleteWhisperBackend, healthCheckBackend, type WhisperBackend, type HealthResult } from '@/api/whisperBackends'

const inputClass = 'w-full bg-dark-800 text-sm text-white rounded px-2 py-1.5 border border-dark-600'
const buttonClass = 'text-xs border border-dark-600 rounded px-2 py-1 text-gray-300 disabled:opacity-50'

export default function WhisperBackendManager() {
  const [backends, setBackends] = useState<WhisperBackend[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [name, setName] = useState('')
  const [url, setURL] = useState('http://whisper:8178')
  const [health, setHealth] = useState<Record<number, HealthResult>>({})

  useEffect(() => {
    let cancelled = false
    listWhisperBackends().then(({ data }) => { if (!cancelled) setBackends(data || []) })
      .catch(() => { if (!cancelled) setError('서버 연결 목록을 읽지 못했습니다.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try { await action() } catch { setError('요청에 실패했습니다. 서버 상태와 입력한 주소를 확인해 주세요.') }
    finally { setBusy(false) }
  }
  const edit = (backend?: WhisperBackend) => {
    setEditing(backend?.id ?? 'new')
    setName(backend?.name ?? '로컬 음성 인식')
    setURL(backend?.url ?? 'http://whisper:8178')
    setError('')
  }
  const save = () => run(async () => {
    if (!name.trim() || !url.trim()) { setError('이름과 서버 주소를 입력해 주세요.'); return }
    if (editing === 'new') {
      await createWhisperBackend({ name: name.trim(), url: url.trim(), backend_type: 'openvino-genai' })
    } else if (editing !== null) {
      await updateWhisperBackend(editing, { name: name.trim(), url: url.trim() })
      setHealth(prev => { const next = { ...prev }; delete next[editing]; return next })
    }
    const { data } = await listWhisperBackends()
    setBackends(data || [])
    setEditing(null)
  })

  if (loading) return <p className="text-sm text-gray-400">연결 목록을 읽는 중입니다.</p>
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">OpenVINO GenAI 연결에서 Whisper와 Qwen을 함께 사용합니다. 기본 주소는 http://whisper:8178입니다.</p>
      {backends.map(backend => (
        <div key={backend.id} className="rounded-lg border border-dark-700 bg-dark-900 p-3 space-y-2">
          <div className="text-sm text-white">{backend.name} · {backend.enabled ? '사용 중' : '사용 안 함'}</div>
          <div className="break-all text-xs text-gray-400">{backend.url}</div>
          <div className="flex flex-wrap gap-2">
            <button className={buttonClass} disabled={busy} onClick={() => run(async () => {
              const { data } = await healthCheckBackend(backend.id)
              setHealth(prev => ({ ...prev, [backend.id]: data }))
            })}>연결 확인</button>
            <button className={buttonClass} disabled={busy} onClick={() => run(async () => {
              await updateWhisperBackend(backend.id, { enabled: !backend.enabled })
              setBackends(prev => prev.map(b => b.id === backend.id ? { ...b, enabled: !b.enabled } : b))
            })}>{backend.enabled ? '사용 중지' : '사용'}</button>
            <button className={buttonClass} disabled={busy} onClick={() => edit(backend)}>수정</button>
            <button className={buttonClass} disabled={busy} onClick={() => {
              if (!window.confirm('이 연결을 삭제할까요? 이 연결을 사용한 작업은 다시 실행할 수 없습니다. 자막과 이력은 유지됩니다.')) return
              void run(async () => {
                await deleteWhisperBackend(backend.id)
                setBackends(prev => prev.filter(b => b.id !== backend.id))
                if (editing === backend.id) setEditing(null)
              })
            }}>삭제</button>
          </div>
          {health[backend.id] && <p role="status" className="text-xs text-gray-300">
            {health[backend.id].ok ? `연결됨 (${health[backend.id].latency_ms ?? 0}ms)` : `연결 실패: ${health[backend.id].error}`}
          </p>}
        </div>
      ))}
      {editing !== null ? <form className="space-y-2 rounded-lg border border-dark-600 p-3" onSubmit={e => { e.preventDefault(); void save() }}>
        <label className="block text-xs text-gray-400">연결 이름<input required aria-label="연결 이름" className={inputClass} value={name} onChange={e => setName(e.target.value)} disabled={busy} /></label>
        <label className="block text-xs text-gray-400">서버 주소<input required type="url" aria-label="서버 주소" className={inputClass} value={url} onChange={e => setURL(e.target.value)} disabled={busy} /></label>
        <div className="flex gap-2"><button className={buttonClass} disabled={busy} type="submit">저장</button><button className={buttonClass} disabled={busy} type="button" onClick={() => setEditing(null)}>취소</button></div>
      </form> : <button className={buttonClass} disabled={busy} onClick={() => edit()}>로컬 연결 추가</button>}
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    </div>
  )
}
