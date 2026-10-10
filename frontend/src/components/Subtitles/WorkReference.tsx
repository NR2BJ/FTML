import { useEffect, useRef, useState } from 'react'
import client from '@/api/client'
import { encodeMediaPath } from '@/utils/mediaPath'
import { useAuthStore } from '@/stores/authStore'

interface Profile {
  scope: string
  title: string
  terms: { original: string; reading: string; korean: string }[]
  songs: { title: string; artist: string; version: string }[]
  sources: { title: string; url: string }[]
}

export default function WorkReference({ path }: { path: string }) {
  const admin = useAuthStore((s) => s.user?.role === 'admin')
  const [profile, setProfile] = useState<Profile | null>(null)
  const [title, setTitle] = useState('')
  const [terms, setTerms] = useState('')
  const [busy, setBusy] = useState(true)
  const [notice, setNotice] = useState('')
  const request = useRef<AbortController | null>(null)
  const url = `/subtitle/reference/${encodeMediaPath(path)}`
  const display = (value: Profile) => {
    setProfile(value)
    setTitle(value.title || (path.split('/').slice(-2, -1)[0] || path.split('/').slice(-1)[0] || '').replace(/\[[^\]]*\]/g, '').trim())
    setTerms((value.terms || []).map((t) => `${t.original} | ${t.reading} | ${t.korean}`).join('\n'))
  }
  useEffect(() => {
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setNotice('')
    setProfile(null)
    client.get<Profile>(url, { signal: controller.signal }).then(({ data }) => {
      if (!controller.signal.aborted) display(data)
    }).catch(() => {
      if (!controller.signal.aborted) setNotice('작품 참고 자료를 읽지 못했습니다.')
    }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => { controller.abort(); request.current?.abort() }
  }, [url])

  const run = async () => {
    if (busy || !profile) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setNotice('')
    try {
      const entries = terms.split('\n').filter((line) => line.trim()).map((line) => {
        const [original = '', reading = '', korean = ''] = line.split('|').map((v) => v.trim())
        return { original, reading, korean }
      })
      const { data } = await client.put<Profile>(url, { ...profile, title, terms: entries }, { signal: controller.signal })
      if (!controller.signal.aborted) { display(data); setNotice('저장했습니다. 이후 등록하는 같은 작품의 추출·번역에 적용됩니다.') }
    } catch (error) {
      if (!controller.signal.aborted) setNotice((error as { response?: { data?: { error?: string } } }).response?.data?.error || '참고 자료 처리에 실패했습니다. 기존 저장본은 유지됩니다.')
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }

  return <details className="rounded-lg border border-dark-600 p-3 text-xs text-gray-300">
    <summary className="cursor-pointer font-medium">작품 용어 사전 (선택)</summary>
    <div className="mt-3 space-y-3">
      <p>작품별로 저장한 이름과 읽기 힌트를 추출·번역에 함께 사용합니다. 저장하지 않은 편집 내용은 작업에 적용되지 않습니다.</p>
      {profile && <p className="break-all text-gray-400">적용 위치: {profile.scope}</p>}
      <label className="block">작품명·시즌
        <input aria-label="참고 작품명" value={title} disabled={!admin || busy} maxLength={200} onChange={(e) => setTitle(e.target.value)} className="mt-1 w-full rounded border border-dark-600 bg-dark-800 p-2 text-white" />
      </label>
      <label className="block">용어 사전 (한 줄에 원어 | 읽기 | 한국어)
        <textarea aria-label="작품 용어 사전" rows={5} value={terms} disabled={!admin || busy} onChange={(e) => setTerms(e.target.value)} className="mt-1 w-full rounded border border-dark-600 bg-dark-800 p-2 text-white" />
      </label>
      {admin && <button type="button" disabled={busy || !profile} onClick={() => void run()} className="rounded bg-primary-600 px-3 py-2 text-white disabled:opacity-50">확인한 참고 자료 저장</button>}
      {!admin && <p>참고 자료 수정은 관리자가 할 수 있습니다.</p>}
      {notice && <p role="status" className="text-amber-300">{notice}</p>}
    </div>
  </details>
}
