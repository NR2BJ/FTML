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
    client.get<Profile>(url, { signal: controller.signal }).then(({ data }) => {
      if (!controller.signal.aborted) display(data)
    }).catch(() => {
      if (!controller.signal.aborted) setNotice('작품 참고 자료를 읽지 못했습니다.')
    }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => { controller.abort(); request.current?.abort() }
  }, [url])

  const run = async (search: boolean) => {
    if (busy || !profile) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setNotice('')
    try {
      if (search) {
        const { data } = await client.post<Profile>(`/subtitle/reference-search/${encodeMediaPath(path)}`, { title }, { signal: controller.signal, timeout: 100000 })
        if (!controller.signal.aborted) { display(data); setNotice('검색 결과입니다. 작품과 표기를 확인한 뒤 저장해 주세요.') }
      } else {
        const entries = terms.split('\n').filter((line) => line.trim()).map((line) => {
          const [original = '', reading = '', korean = ''] = line.split('|').map((v) => v.trim())
          return { original, reading, korean }
        })
        const { data } = await client.put<Profile>(url, { ...profile, title, terms: entries }, { signal: controller.signal })
        if (!controller.signal.aborted) { display(data); setNotice('저장했습니다. 이후 등록하는 같은 작품의 추출·번역에 적용됩니다.') }
      }
    } catch (error) {
      if (!controller.signal.aborted) setNotice((error as { response?: { data?: { error?: string } } }).response?.data?.error || '참고 자료 처리에 실패했습니다. 기존 저장본은 유지됩니다.')
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }

  return <details className="rounded-lg border border-dark-600 p-3 text-xs text-gray-300">
    <summary className="cursor-pointer font-medium">작품 이름·용어·노래 참고</summary>
    <div className="mt-3 space-y-3">
      <p>작품별로 저장한 이름과 읽기 힌트를 추출·번역에 함께 사용합니다. 저장하지 않은 편집 내용은 작업에 적용되지 않습니다.</p>
      {profile && <p className="break-all text-gray-400">적용 위치: {profile.scope}</p>}
      <label className="block">작품명·시즌
        <input aria-label="참고 작품명" value={title} disabled={!admin || busy} maxLength={200} onChange={(e) => setTitle(e.target.value)} className="mt-1 w-full rounded border border-dark-600 bg-dark-800 p-2 text-white" />
      </label>
      {admin && <><button type="button" disabled={busy || !profile || !title.trim()} onClick={() => void run(true)} className="rounded bg-dark-700 px-3 py-2 disabled:opacity-50">{busy ? '처리 중' : 'Gemini로 용어·곡 정보 검색'}</button>
        <p className="text-gray-400">입력한 작품명으로 Wikipedia 자료를 조회하고 Gemini에 작품명·공개 자료를 전달합니다. 영상·전체 경로는 보내지 않습니다. API 비용이 발생하며, 백과사전 정보는 공식 표기와 다를 수 있어 동명이작·시즌과 출처를 확인해 주세요.</p></>}
      <label className="block">용어 사전 (한 줄에 원어 | 읽기 | 한국어)
        <textarea aria-label="작품 용어 사전" rows={5} value={terms} disabled={!admin || busy} onChange={(e) => setTerms(e.target.value)} className="mt-1 w-full rounded border border-dark-600 bg-dark-800 p-2 text-white" />
      </label>
      {!!profile?.songs?.length && <div><p className="font-medium">검색된 곡 후보</p>{profile.songs.map((song, i) => <p key={i}>{song.title} · {song.artist} · {song.version}</p>)}<p className="mt-1 text-amber-400">곡 후보만으로 가사를 대체하지 않습니다. TV판 편집과 실제 부른 구간 확인이 필요합니다.</p></div>}
      {!!profile?.sources?.length && <div className="flex flex-wrap gap-2">{profile.sources.filter((s) => s.url.startsWith('https://')).map((s, i) => <a key={i} href={s.url} target="_blank" rel="noreferrer" className="text-primary-400 underline">{s.title || `출처 ${i + 1}`}</a>)}</div>}
      {admin && <button type="button" disabled={busy || !profile} onClick={() => void run(false)} className="rounded bg-primary-600 px-3 py-2 text-white disabled:opacity-50">확인한 참고 자료 저장</button>}
      {!admin && <p>참고 자료 수정과 외부 검색은 관리자가 할 수 있습니다.</p>}
      {notice && <p role="status" className="text-amber-300">{notice}</p>}
    </div>
  </details>
}
