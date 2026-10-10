import { useEffect, useRef, useState } from 'react'
import { X, Loader2, Check, RotateCcw } from 'lucide-react'
import {
  listSubtitles,
  submitSubtitleTasks,
  type SubtitleEntry,
  type SubtitleTaskItem,
  type SubtitleTaskMode,
} from '@/api/subtitle'
import { cancelJob, retryJob } from '@/api/job'
import {
  listAvailableEngines,
  type AvailableEngine,
} from '@/api/whisperBackends'
import { useJobStore } from '@/stores/jobStore'
import {
  taskModeLabels,
  taskStatusLabels,
  workflowFinished,
  workflowJobs,
  isJobTerminal,
} from '@/utils/subtitleTasks'
import { useSubtitleTasks } from './useSubtitleTasks'
import WorkReference from './WorkReference'
import SubtitleLibrary from './SubtitleLibrary'
import { useAuthStore } from '@/stores/authStore'
import ExtractionDiagnostics from './ExtractionDiagnostics'
import TranslationOptions, {
  defaultTranslationOptions,
  subtitleLanguages,
} from './TranslationOptions'

interface Props {
  paths: string[]
  initialMode: SubtitleTaskMode
  subtitleId?: string
  audioTrack?: number
  onClose: () => void
}

export default function SubtitleTaskDialog({
  paths,
  initialMode,
  subtitleId = '',
  audioTrack = 0,
  onClose,
}: Props) {
  const role = useAuthStore(s => s.user?.role)
  const canEdit = role === 'admin' || role === 'user'
  const [tab, setTab] = useState<SubtitleTaskMode | 'manage' | 'progress'>(canEdit ? initialMode : 'manage')
  const [mode, setMode] = useState(initialMode)
  const globalCompleted = useJobStore(s => s.jobs.filter(j => paths.includes(j.file_path) && j.status === 'completed').map(j => j.id).sort().join(','))
  const [engine, setEngine] = useState('')
  const [engines, setEngines] = useState<AvailableEngine[]>([])
  const [language, setLanguage] = useState('auto')
  const [model, setModel] = useState('OpenVINO/whisper-large-v3-int8-ov')
  const [observeSpeech, setObserveSpeech] = useState(false)
  const [translation, setTranslation] = useState(defaultTranslationOptions)
  const [source, setSource] = useState(subtitleId)
  const [subtitles, setSubtitles] = useState<SubtitleEntry[]>([])
  const [sourceError, setSourceError] = useState('')
  const [items, setItems] = useState<SubtitleTaskItem[] | null>(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const submission = useRef(false)
  const roots =
    items?.flatMap((item) => (item.job_id ? [item.job_id] : [])) || []
  const { jobs, error: pollError, refresh } = useSubtitleTasks(roots)
  const completedVersion = `${globalCompleted};${jobs.filter(j => j.status === 'completed').map(j => j.id).sort().join(',')}`
  const firstPath = paths[0]
  const single = paths.length === 1
  const localASR = engines.find((e) => e.value === engine)?.type === 'openvino-genai'
  const finished =
    roots.length > 0 && roots.every((id) => workflowFinished(id, jobs))

  useEffect(() => {
    if (!canEdit || mode === 'translate') return
    let cancelled = false
    listAvailableEngines()
      .then(({ data }) => {
        if (cancelled) return
        setEngines(data || [])
        setEngine((current) => current || data?.[0]?.value || '')
      })
      .catch(() => {
        if (!cancelled) setError('로컬 음성 인식 연결 목록을 읽지 못했습니다.')
      })
    return () => {
      cancelled = true
    }
  }, [mode, canEdit])
  useEffect(() => {
    if (mode !== 'translate' || !single) return
    const controller = new AbortController()
    setSourceError('')
    listSubtitles(firstPath, controller.signal)
      .then(({ data }) => {
        if (!controller.signal.aborted) {
          setSubtitles(data || [])
          setSource(current => data?.some(sub => sub.id === current) ? current : '')
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setSourceError('원본 자막 목록을 읽지 못했습니다.')
      })
    return () => controller.abort()
  }, [mode, single, firstPath, completedVersion, tab])

  const start = async () => {
    if (submission.current || !canEdit) return
    submission.current = true
    setSubmitting(true)
    setError('')
    try {
      const custom =
        translation.preset === 'custom' ||
        translation.preset.startsWith('saved:')
      const { data } = await submitSubtitleTasks({
        paths,
        mode,
        generate: {
          engine, language,
          model: localASR ? model : '',
          audio_track: single ? audioTrack : 0,
          observe_speech: localASR && observeSpeech,
        },
        translate:
          mode === 'generate'
            ? undefined
            : {
                subtitle_id: single ? source : '',
                engine: 'gemini',
                target_lang: translation.targetLang,
                preset: custom ? 'custom' : translation.preset,
                custom_prompt: custom ? translation.prompt : undefined,
              },
      })
      setItems(data.items)
      setTab('progress')
      void useJobStore.getState().fetchActiveJobs()
    } catch (error) {
      setError((error as { response?: { data?: { error?: string } } }).response?.data?.error || '작업을 시작하지 못했습니다. 연결 상태와 설정을 확인해 주세요.')
    } finally {
      submission.current = false
      setSubmitting(false)
    }
  }
  const changeJob = async (id: string, action: 'retry' | 'cancel') => {
    if (busy) return
    setBusy(id)
    setError('')
    try {
      if (action === 'retry') {
        const { data } = await retryJob(id)
        setItems(
          (previous) =>
            previous?.map((item) =>
              item.job_id === id ? { ...item, job_id: data.job_id } : item
            ) || null
        )
      } else await cancelJob(id)
      refresh()
      void useJobStore.getState().fetchActiveJobs()
    } catch {
      setError('작업 상태를 변경하지 못했습니다.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="subtitle-task-dialog fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="자막 작업"
        className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-xl border border-dark-600 bg-dark-900 text-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-dark-700 p-4">
          <div>
            <h2 className="font-semibold">자막 작업</h2>
            <p className="mt-1 break-all text-xs text-gray-400">
              {single ? firstPath : `영상 ${paths.length}개`}
            </p>
          </div>
          <button
            aria-label="자막 작업 닫기"
            onClick={onClose}
            className="p-2 text-gray-400"
          >
            <X size={18} />
          </button>
        </header>
        <div className="space-y-4 overflow-y-auto p-4">
          <div className="flex flex-wrap gap-1 rounded-lg bg-dark-800 p-1" aria-label="작업 종류">
            {canEdit && (Object.keys(taskModeLabels) as SubtitleTaskMode[]).map(value =>
              <button key={value} disabled={submitting} aria-pressed={tab === value}
                onClick={() => { setMode(value); setTab(value) }}
                className={`flex-1 rounded px-2 py-2 text-sm ${tab === value ? 'bg-primary-600 text-white' : 'text-gray-400'}`}>
                {taskModeLabels[value]}
              </button>
            )}
            {items && <button aria-pressed={tab === 'progress'} onClick={() => setTab('progress')} className="rounded px-2 py-2 text-sm text-primary-400">진행 상황</button>}
            <button aria-pressed={tab === 'manage'} disabled={submitting} onClick={() => setTab('manage')}
              className={`flex-1 rounded px-2 py-2 text-sm ${tab === 'manage' ? 'bg-primary-600 text-white' : 'text-gray-400'}`}>자막 삭제</button>
          </div>
          {tab === 'manage' ? <SubtitleLibrary paths={paths} version={completedVersion} /> : tab !== 'progress' ? (
            <>
              {mode !== 'translate' && (
                <div className="space-y-3">
                  <label className="block text-xs text-gray-400">
                    로컬 음성 인식 연결
                    <select
                      aria-label="로컬 음성 인식 연결"
                      className="mt-1 w-full rounded border border-dark-600 bg-dark-800 p-2 text-white"
                      value={engine}
                      onChange={(e) => setEngine(e.target.value)}
                    >
                      {engines.map((e) => (
                        <option key={e.value} value={e.value}>
                          {e.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!engines.length && (
                    <p className="text-xs text-amber-400">
                      설정에서 사용 가능한 로컬 음성 인식 연결을 확인해 주세요.
                    </p>
                  )}
                  <label className="block text-xs text-gray-400">
                    추출 모델
                    <select aria-label="추출 모델" value={model} disabled={!localASR} onChange={(e) => setModel(e.target.value)}
                      className="mt-1 w-full rounded border border-dark-600 bg-dark-800 p-2 text-white">
                      <option value="OpenVINO/whisper-large-v3-int8-ov">Whisper large-v3 INT8</option>
                      <option value="Qwen/Qwen3-ASR-1.7B">Qwen3-ASR 1.7B INT8 (비교용)</option>
                    </select>
                  </label>
                  {localASR && model.startsWith('Qwen/') && <p className="text-xs text-amber-400">
                    로컬 OpenVINO 연결용입니다. 최초 실행은 모델 다운로드·변환이 필요합니다.
                    인식은 GPU, 시간 정렬은 CPU에서 수행하며 Whisper 결과는 보존합니다.
                    A380에서 정확도와 메모리 사용량을 확인할 비교 기능입니다.
                  </p>}
                  <label className="block text-xs text-gray-400">
                    음성 언어
                    <select
                      aria-label="음성 언어"
                      className="mt-1 w-full rounded border border-dark-600 bg-dark-800 p-2 text-white"
                      value={language}
                      onChange={(e) => setLanguage(e.target.value)}
                    >
                      <option value="auto">자동 감지</option>
                      {subtitleLanguages.map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="text-xs text-gray-500">
                    음성 트랙 {single ? audioTrack + 1 : 1}에서 추출합니다.
                    기본 모델은 Whisper large-v3 INT8입니다.
                    Whisper는 긴 선행 무음이 첫 단어에 붙은 경우만 말소리 경계와 대조합니다. 원음을 잘라 인식하거나 대사를 삭제하지 않습니다.
                  </p>
                  {localASR && <label className="flex items-center gap-2 text-xs text-gray-400"><input type="checkbox" checked={observeSpeech} onChange={(e) => setObserveSpeech(e.target.checked)} />Silero 말소리 검출 비교: 기록만 남기고 오디오·자막을 자르지 않음</label>}
                </div>
              )}
              {mode === 'translate' && (
                <div className="space-y-1">
                  {single ? (
                    <label className="block text-xs text-gray-400">
                      번역할 자막
                      <select
                        aria-label="번역할 자막"
                        className="mt-1 w-full rounded border border-dark-600 bg-dark-800 p-2 text-white"
                        value={source}
                        onChange={(e) => setSource(e.target.value)}
                      >
                        <option value="">자동 선택</option>
                        {subtitles.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <p className="text-xs text-gray-400">
                      영상마다 번역할 원본 자막을 자동 선택합니다.
                    </p>
                  )}
                  <p className="text-xs text-gray-500">
                    자동 선택: Whisper 추출본 → 업로드본 → 내장 → 외부 자막.
                    기존 번역본은 제외합니다.
                  </p>
                  {sourceError && (
                    <p role="alert" className="text-xs text-red-400">
                      {sourceError}
                    </p>
                  )}
                </div>
              )}
              {mode !== 'generate' && (
                <TranslationOptions
                  value={translation}
                  onChange={setTranslation}
                />
              )}
              {single ? <WorkReference key={firstPath} path={firstPath} /> : <p className="text-xs text-gray-400">영상마다 해당 작품 폴더에 저장된 용어 사전을 적용합니다.</p>}
              {mode === 'generate-translate' && (
                <p className="text-xs text-amber-400">
                  추출한 결과를 그대로 번역합니다. 번역만 실패하면 추출을
                  반복하지 않고 번역만 재시도합니다.
                </p>
              )}
              <p className="text-xs text-gray-500">
                같은 설정으로 진행 중인 작업은 재사용합니다. 완료 후 다시
                실행하면 기존 결과 파일을 교체할 수 있습니다.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm">
                {roots.length === 0
                  ? '등록된 작업 없음'
                  : finished
                    ? '작업 종료'
                    : '작업 진행 중'}{' '}
                · {roots.filter((id) => workflowFinished(id, jobs)).length}/
                {roots.length}개 영상
              </p>
              {items?.map((item) => (
                <div
                  key={item.path}
                  className="rounded-lg border border-dark-700 bg-dark-800 p-3"
                >
                  <p className="break-all text-sm text-gray-300">{item.path}</p>
                  {item.reason ? (
                    <p className="mt-2 text-xs text-amber-400">
                      제외: {item.reason}
                    </p>
                  ) : (
                    workflowJobs(item.job_id!, jobs).map((j) => (
                      <div
                        key={j.id}
                        className="mt-2 flex items-center gap-2 text-xs"
                      >
                        {j.status === 'completed' ? (
                          <Check size={14} />
                        ) : isJobTerminal(j) ? (
                          <X size={14} />
                        ) : (
                          <Loader2 size={14} className="animate-spin" />
                        )}
                        <span
                          className={
                            j.type === 'transcribe'
                              ? 'text-blue-400'
                              : 'text-green-400'
                          }
                        >
                          {j.type === 'transcribe' ? '추출' : '번역'}
                        </span>
                        <span>
                          {taskStatusLabels[j.status]}
                          {!isJobTerminal(j)
                            ? ` ${Math.round(j.progress * 100)}%`
                            : ''}
                        </span>
                        {j.error && (
                          <span className="min-w-0 flex-1 break-words text-red-400">
                            {j.error}
                          </span>
                        )}
                        {Number(j.result?.plain_effect_fallbacks) > 0 && (
                          <span className="text-amber-400">
                            복잡한 효과{' '}
                            {Number(j.result?.plain_effect_fallbacks)}개는 원문
                            효과와 일반 번역문으로 보존
                          </span>
                        )}
                        {!!j.result?.raw_path && <span className="text-gray-400">가사 보정 전 원 추출본도 보존됨</span>}
                        <ExtractionDiagnostics value={j.result?.diagnostics} />
                        {['failed', 'cancelled'].includes(j.status) && (
                          <button
                            aria-label={`${j.type === 'transcribe' ? '추출' : '번역'} 재시도`}
                            disabled={!!busy}
                            onClick={() => changeJob(j.id, 'retry')}
                            className="ml-auto flex gap-1 text-primary-400"
                          >
                            <RotateCcw size={12} />
                            재시도
                          </button>
                        )}
                        {!isJobTerminal(j) && (
                          <button
                            disabled={!!busy}
                            onClick={() => changeJob(j.id, 'cancel')}
                            className="ml-auto text-red-400"
                          >
                            취소
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              ))}
              {pollError && (
                <p role="alert" className="text-sm text-amber-400">
                  {pollError}
                </p>
              )}
              <p className="text-xs text-gray-500">
                이 창을 닫아도 작업은 계속됩니다. ‘자막 작업’ 화면에서 영상별
                이력을 확인할 수 있습니다.
              </p>
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-dark-700 p-4">
          <button
            onClick={onClose}
            className="rounded px-3 py-2 text-sm text-gray-400"
          >
            닫기
          </button>
          {canEdit && tab !== 'manage' && tab !== 'progress' && (
            <button
              disabled={
                submitting ||
                !paths.length ||
                paths.length > 200 ||
                (mode !== 'translate' && !engine)
              }
              onClick={start}
              className="rounded bg-primary-600 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {submitting
                ? '등록 중…'
                : paths.length > 200
                  ? '한 번에 최대 200개'
                  : `${taskModeLabels[mode]} 시작`}
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}
