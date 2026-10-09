import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ChevronDown,
  ChevronRight,
  Play,
  RefreshCw,
  Search,
} from 'lucide-react'
import {
  cancelJob,
  retryJob,
  getVideoJobHistory,
  getJobHistory,
  type Job,
  type VideoJobHistory,
  type HistoryPage,
} from '@/api/job'
import {
  listSubtitles,
  type SubtitleEntry,
  type SubtitleTaskMode,
} from '@/api/subtitle'
import { useAuthStore } from '@/stores/authStore'
import { useJobStore } from '@/stores/jobStore'
import { encodeMediaPath } from '@/utils/mediaPath'
import {
  formatDurationBetween,
  formatElapsed,
  estimateRemaining,
} from '@/utils/format'
import { downloadSubtitle } from '@/utils/downloadSubtitle'
import { taskStatusLabels, isJobTerminal } from '@/utils/subtitleTasks'
import SubtitleTaskDialog from '@/components/Subtitles/SubtitleTaskDialog'

type Task = { path: string; mode: SubtitleTaskMode; subtitleId?: string }
const when = (value?: string) =>
  value ? new Date(value).toLocaleString('ko-KR') : '-'

function VideoDetails({
  path,
  version,
  canEdit,
  onTask,
  onChanged,
}: {
  path: string
  version: string
  canEdit: boolean
  onTask: (task: Task) => void
  onChanged: () => void
}) {
  const [page, setPage] = useState(1)
  const [history, setHistory] = useState<HistoryPage<Job> | null>(null)
  const [subtitles, setSubtitles] = useState<SubtitleEntry[]>([])
  const [error, setError] = useState('')
  const [subtitleError, setSubtitleError] = useState('')
  const [busy, setBusy] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const { data } = await getJobHistory(path, page, controller.signal)
        if (controller.signal.aborted) return
        setHistory(data)
        setError('')
      } catch {
        if (!controller.signal.aborted) setError('작업 이력을 읽지 못했습니다.')
      }
      if (!controller.signal.aborted) timer = setTimeout(read, 5000)
    }
    void read()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [path, page, revision, version])
  const completionKey =
    history?.items
      .filter((j) => j.status === 'completed')
      .map((j) => j.id)
      .join(',') || ''
  useEffect(() => {
    const controller = new AbortController()
    listSubtitles(path, controller.signal)
      .then(({ data }) => {
        if (!controller.signal.aborted) {
          setSubtitles((data || []).filter((s) => s.type === 'generated'))
          setSubtitleError('')
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setSubtitleError(
            '현재 자막을 읽지 못했습니다. 영상이 이동되거나 삭제됐을 수 있습니다.'
          )
      })
    return () => controller.abort()
  }, [path, completionKey, revision, version])
  const change = async (j: Job) => {
    if (busy) return
    setBusy(j.id)
    try {
      if (isJobTerminal(j)) await retryJob(j.id)
      else await cancelJob(j.id)
      setRevision((n) => n + 1)
      onChanged()
      void useJobStore.getState().fetchActiveJobs()
    } catch {
      setError('작업 상태를 변경하지 못했습니다.')
    } finally {
      setBusy('')
    }
  }
  const download = async (sub: SubtitleEntry) => {
    if (busy) return
    setBusy(sub.id)
    try {
      await downloadSubtitle(
        path,
        sub,
        ['ass', 'srt', 'vtt'].includes(sub.format) ? sub.format : 'srt'
      )
    } catch {
      setError('자막을 다운로드하지 못했습니다.')
    } finally {
      setBusy('')
    }
  }
  const retried = new Set(history?.items.map((j) => j.retry_of).filter(Boolean))
  return (
    <div className="space-y-4 border-t border-dark-700 bg-dark-800/30 p-4">
      <div>
        <h3 className="mb-2 text-sm font-medium text-gray-300">
          현재 결과 자막
        </h3>
        {subtitleError ? (
          <p className="text-xs text-amber-400">{subtitleError}</p>
        ) : subtitles.length === 0 ? (
          <p className="text-xs text-gray-500">
            저장된 생성·번역 자막이 없습니다. 아래 작업 이력은 그대로
            보존됩니다.
          </p>
        ) : (
          <div className="space-y-1">
            {subtitles.map((sub) => (
              <div
                key={sub.id}
                className="flex flex-wrap items-center gap-2 text-xs"
              >
                <span className="min-w-0 flex-1 break-all text-gray-300">
                  {sub.label} · {sub.format.toUpperCase()}
                </span>
                {canEdit && (
                  <>
                    <button
                      disabled={!!busy}
                      onClick={() => download(sub)}
                      className="text-primary-400"
                    >
                      다운로드
                    </button>
                    <button
                      onClick={() =>
                        onTask({ path, mode: 'translate', subtitleId: sub.id })
                      }
                      className="text-green-400"
                    >
                      이 자막 번역
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium text-gray-300">
          상세 작업 이력 · {history?.total ?? 0}건
        </h3>
        {error && (
          <p role="alert" className="mb-2 text-xs text-red-400">
            {error}
          </p>
        )}
        {!history && !error && (
          <p className="text-xs text-gray-500">이력 읽는 중…</p>
        )}
        <div className="space-y-2">
          {history?.items.map((j) => (
            <div
              key={j.id}
              className="rounded border border-dark-700 p-3 text-xs"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={
                    j.type === 'transcribe' ? 'text-blue-400' : 'text-green-400'
                  }
                >
                  {j.type === 'transcribe' ? '자막 추출' : '자막 번역'}
                </span>
                <span
                  className={
                    j.status === 'failed'
                      ? 'text-red-400'
                      : j.status === 'completed'
                        ? 'text-green-400'
                        : 'text-gray-300'
                  }
                >
                  {taskStatusLabels[j.status]}
                </span>
                {!isJobTerminal(j) && (
                  <span className="text-gray-400">
                    {Math.round(j.progress * 100)}%
                  </span>
                )}
                {j.parent_id && (
                  <span className="text-amber-400" title={j.parent_id}>
                    추출 후 번역
                  </span>
                )}
                {j.retry_of && (
                  <span className="text-gray-400" title={j.retry_of}>
                    이전 작업 재시도
                  </span>
                )}
                {retried.has(j.id) ? (
                  <span className="ml-auto text-gray-500">
                    재시도 기록 있음
                  </span>
                ) : (
                  canEdit &&
                  j.status !== 'completed' && (
                    <button
                      disabled={!!busy}
                      onClick={() => change(j)}
                      className="ml-auto text-primary-400"
                    >
                      {isJobTerminal(j) ? '재시도' : '취소'}
                    </button>
                  )
                )}
              </div>
              <p className="mt-1 text-gray-500">
                등록 {when(j.created_at)} · 시작 {when(j.started_at)} · 종료{' '}
                {when(j.completed_at)}
              </p>
              {j.started_at && (
                <p className="mt-1 text-gray-500">
                  {isJobTerminal(j)
                    ? `소요 ${formatDurationBetween(j.started_at, j.completed_at) || '-'}`
                    : `경과 ${formatElapsed(j.started_at)} · 남은 시간 ${estimateRemaining(j.started_at, j.progress) || '계산 중'}`}
                </p>
              )}
              <p className="mt-1 break-all text-gray-400">
                {j.type === 'transcribe'
                  ? `음성 ${String(j.params?.language || 'auto')} · 트랙 ${Number(j.params?.audio_track || 0) + 1} · ${String(j.params?.engine || '기본 연결')}`
                  : `${String(j.params?.subtitle_id || '원본')} → ${String(j.params?.target_lang || '')} · ${String(j.params?.engine || 'Gemini')}`}
              </p>
              {!!j.result?.output_path && (
                <p className="mt-1 break-all text-gray-500">
                  결과: {String(j.result.output_path)}
                </p>
              )}
              {j.error && (
                <p className="mt-1 break-words text-red-400">{j.error}</p>
              )}
              <details className="mt-2 text-gray-500">
                <summary className="cursor-pointer">
                  작업 번호와 저장된 설정
                </summary>
                <p className="mt-1 break-all">작업 번호: {j.id}</p>
                {j.parent_id && (
                  <p className="break-all">연결된 추출: {j.parent_id}</p>
                )}
                {j.retry_of && (
                  <p className="break-all">이전 시도: {j.retry_of}</p>
                )}
                {!!j.params?.model && <p>모델: {String(j.params.model)}</p>}
                {!!j.params?.preset && (
                  <p>번역 지침: {String(j.params.preset)}</p>
                )}
                {!!j.params?.custom_prompt && (
                  <p className="mt-1 whitespace-pre-wrap break-words">
                    {String(j.params.custom_prompt)}
                  </p>
                )}
                {Number(j.result?.plain_effect_fallbacks) > 0 && (
                  <p>
                    복잡한 효과 {Number(j.result?.plain_effect_fallbacks)}개는
                    원문 효과와 일반 번역문으로 보존
                  </p>
                )}
              </details>
            </div>
          ))}
        </div>
        {history && history.total > 50 && (
          <div className="mt-3 flex items-center justify-end gap-3 text-xs text-gray-400">
            <button disabled={page === 1} onClick={() => setPage((n) => n - 1)}>
              이전
            </button>
            <span>
              {page} / {Math.ceil(history.total / 50)}
            </span>
            <button
              disabled={page * 50 >= history.total}
              onClick={() => setPage((n) => n + 1)}
            >
              다음
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default function Jobs() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<HistoryPage<VideoJobHistory> | null>(
    null
  )
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [task, setTask] = useState<Task | null>(null)
  const [revision, setRevision] = useState(0)
  const user = useAuthStore((s) => s.user)
  const canEdit = user?.role === 'admin' || user?.role === 'user'
  const refresh = () => setRevision((n) => n + 1)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const { data } = await getVideoJobHistory(
          search,
          status,
          page,
          controller.signal
        )
        if (controller.signal.aborted) return
        setResult(data)
        setError('')
      } catch {
        if (!controller.signal.aborted)
          setError('영상별 작업 목록을 읽지 못했습니다.')
      }
      if (!controller.signal.aborted) timer = setTimeout(read, 5000)
    }
    timer = setTimeout(read, 250)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [search, status, page, revision])
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white">자막 작업</h1>
          <p className="mt-1 text-sm text-gray-500">
            추출·번역한 영상을 모아 보고, 결과와 작업 이력을 확인합니다.
          </p>
        </div>
        <button
          aria-label="작업 목록 새로고침"
          onClick={refresh}
          className="p-2 text-gray-400"
        >
          <RefreshCw size={18} />
        </button>
      </header>
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-48 flex-1 items-center gap-2 rounded-lg border border-dark-600 bg-dark-900 px-3">
          <Search size={16} className="text-gray-500" />
          <input
            aria-label="작업한 영상 검색"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            placeholder="파일명 또는 폴더 경로 검색"
            className="w-full bg-transparent py-2 text-sm text-white outline-none"
          />
        </label>
        <select
          aria-label="작업 상태"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            setPage(1)
          }}
          className="rounded-lg border border-dark-600 bg-dark-900 p-2 text-sm text-white"
        >
          <option value="all">모든 영상</option>
          <option value="active">진행 중인 작업 있음</option>
          <option value="completed">완료 기록 있음</option>
          <option value="failed">실패 기록 있음</option>
        </select>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      <p className="text-xs text-gray-500">
        {result ? `${result.total}개 영상` : '목록 읽는 중…'} · 실패·취소·재시도
        기록도 보존합니다.
      </p>
      <div className="space-y-3">
        {result?.items.map((video) => (
          <article
            key={video.file_path}
            className="overflow-hidden rounded-xl border border-dark-700 bg-dark-900"
          >
            <div className="flex flex-wrap items-center gap-3 p-4">
              <button
                aria-expanded={expanded === video.file_path}
                onClick={() =>
                  setExpanded(
                    expanded === video.file_path ? null : video.file_path
                  )
                }
                className="flex min-w-0 flex-1 items-start gap-2 text-left"
              >
                {expanded === video.file_path ? (
                  <ChevronDown size={18} className="shrink-0 text-gray-500" />
                ) : (
                  <ChevronRight size={18} className="shrink-0 text-gray-500" />
                )}
                <span className="min-w-0">
                  <span className="block break-all text-sm font-medium text-white">
                    {video.file_path.split('/').pop()}
                  </span>
                  <span className="mt-1 block break-all text-xs text-gray-500">
                    {video.file_path}
                  </span>
                  <span className="mt-2 flex flex-wrap gap-3 text-xs">
                    <span className="text-blue-400">진행 {video.active}</span>
                    <span className="text-green-400">
                      완료 {video.completed}
                    </span>
                    <span className="text-red-400">실패 {video.failed}</span>
                    <span className="text-gray-500">
                      최근 {when(video.last_created_at)}
                    </span>
                  </span>
                </span>
              </button>
              <Link
                aria-label={`${video.file_path} 재생`}
                to={`/watch/${encodeMediaPath(video.file_path)}`}
                className="flex items-center gap-1 rounded px-2 py-1 text-sm text-primary-400"
              >
                <Play size={14} />
                재생
              </Link>
              {canEdit && (
                <button
                  onClick={() =>
                    setTask({
                      path: video.file_path,
                      mode: 'generate-translate',
                    })
                  }
                  className="rounded border border-dark-600 px-3 py-1.5 text-xs text-gray-300"
                >
                  새 자막 작업
                </button>
              )}
            </div>
            {expanded === video.file_path && (
              <VideoDetails
                path={video.file_path}
                version={`${revision}:${video.total}:${video.completed}`}
                canEdit={canEdit}
                onTask={setTask}
                onChanged={refresh}
              />
            )}
          </article>
        ))}
      </div>
      {result?.total === 0 && (
        <p className="rounded-xl border border-dark-700 p-10 text-center text-sm text-gray-500">
          해당하는 영상이 없습니다. 기존 DB에 남아 있는 작업 기록부터
          표시합니다.
        </p>
      )}
      {result && result.total > result.page_size && (
        <div className="flex items-center justify-end gap-3 text-sm text-gray-400">
          <button disabled={page === 1} onClick={() => setPage((n) => n - 1)}>
            이전
          </button>
          <span>
            {page} / {Math.ceil(result.total / result.page_size)}
          </span>
          <button
            disabled={page * result.page_size >= result.total}
            onClick={() => setPage((n) => n + 1)}
          >
            다음
          </button>
        </div>
      )}
      <p className="text-xs text-gray-500">
        예전 작업은 단계 연결 정보가 없어 별도 기록으로 보일 수 있습니다. 이미
        삭제된 DB 기록은 자동 복원할 수 없습니다.
      </p>
      {task && (
        <SubtitleTaskDialog
          key={`${task.path}:${task.mode}:${task.subtitleId || ''}`}
          paths={[task.path]}
          initialMode={task.mode}
          subtitleId={task.subtitleId}
          onClose={() => {
            setTask(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}
