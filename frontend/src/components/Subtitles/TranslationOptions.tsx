import { useEffect, useState } from 'react'
import {
  listPresets,
  createPreset,
  updatePreset,
  deletePreset,
  type TranslationPreset,
} from '@/api/subtitle'

export const subtitleLanguages = [
  ['ko', '한국어'],
  ['ja', '일본어'],
  ['en', '영어'],
  ['zh', '중국어'],
  ['es', '스페인어'],
  ['fr', '프랑스어'],
  ['de', '독일어'],
]
export interface TranslationOptionsValue {
  targetLang: string
  preset: string
  prompt: string
}
export const defaultTranslationOptions: TranslationOptionsValue = {
  targetLang: 'ko',
  preset: 'anime',
  prompt: '',
}
const field =
  'w-full rounded border border-dark-600 bg-dark-800 px-2 py-1.5 text-sm text-white'

export default function TranslationOptions({
  value,
  onChange,
}: {
  value: TranslationOptionsValue
  onChange: (value: TranslationOptionsValue) => void
}) {
  const [presets, setPresets] = useState<TranslationPreset[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let cancelled = false
    listPresets()
      .then(({ data }) => {
        if (!cancelled) setPresets(data || [])
      })
      .catch(() => {
        if (!cancelled) setError('저장된 번역 지침을 읽지 못했습니다.')
      })
    return () => {
      cancelled = true
    }
  }, [])
  const custom = value.preset === 'custom' || value.preset.startsWith('saved:')
  const selected = presets.find((p) => `saved:${p.id}` === value.preset)
  const save = async (action: 'create' | 'update' | 'delete') => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (action === 'create')
        await createPreset(name.trim(), value.prompt.trim())
      else if (selected && action === 'update')
        await updatePreset(
          selected.id,
          name.trim() || selected.name,
          value.prompt.trim()
        )
      else if (selected) {
        await deletePreset(selected.id)
        onChange({ ...value, preset: 'custom' })
      }
      const { data } = await listPresets()
      setPresets(data || [])
      setName('')
    } catch {
      setError('번역 지침을 저장하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-3">
      <label className="block text-xs text-gray-400">
        번역 언어 · Gemini
        <select
          aria-label="번역 언어"
          className={field}
          value={value.targetLang}
          onChange={(e) => onChange({ ...value, targetLang: e.target.value })}
        >
          {subtitleLanguages.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs text-gray-400">
        번역 지침
        <select
          aria-label="번역 지침"
          className={field}
          value={value.preset}
          onChange={(e) => {
            const preset = e.target.value
            const saved = presets.find((p) => `saved:${p.id}` === preset)
            onChange({ ...value, preset, prompt: saved?.prompt || '' })
            setName('')
          }}
        >
          <option value="anime">애니메이션</option>
          <option value="movie">영화·드라마</option>
          <option value="documentary">다큐멘터리</option>
          <option value="custom">직접 작성</option>
          {presets.map((p) => (
            <option key={p.id} value={`saved:${p.id}`}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {custom && (
        <>
          <textarea
            aria-label="번역 요청 사항"
            className={`${field} h-24`}
            value={value.prompt}
            onChange={(e) => onChange({ ...value, prompt: e.target.value })}
          />
          <div className="flex flex-wrap gap-2 text-xs">
            <input
              aria-label="번역 지침 이름"
              className={field}
              placeholder={selected?.name || '저장할 지침 이름'}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="button"
              disabled={busy || !name.trim() || !value.prompt.trim()}
              onClick={() => save('create')}
              className="text-primary-400 disabled:opacity-40"
            >
              새 지침으로 저장
            </button>
            {selected && (
              <>
                <button
                  type="button"
                  disabled={busy || !value.prompt.trim()}
                  onClick={() => save('update')}
                  className="text-primary-400"
                >
                  기존 지침 수정
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => save('delete')}
                  className="text-red-400"
                >
                  지침 삭제
                </button>
              </>
            )}
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  )
}
