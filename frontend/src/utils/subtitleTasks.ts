import type { Job } from '@/api/job'

export const taskModeLabels = {
  generate: '자막 추출',
  translate: '자막 번역',
  'generate-translate': '추출 후 번역',
}
export const taskStatusLabels = {
  pending: '대기',
  running: '진행 중',
  completed: '완료',
  failed: '실패',
  cancelled: '취소',
}
export const isJobTerminal = (job: Job) =>
  ['completed', 'failed', 'cancelled'].includes(job.status)

export function workflowJobs(rootID: string, jobs: Job[]): Job[] {
  const related = jobs.filter((j) => j.id === rootID || j.parent_id === rootID)
  const replaced = new Set(related.map((j) => j.retry_of).filter(Boolean))
  return related.filter((j) => !replaced.has(j.id))
}

export function workflowFinished(rootID: string, jobs: Job[]): boolean {
  const related = workflowJobs(rootID, jobs)
  const root = related.find((j) => j.id === rootID)
  if (!root || !isJobTerminal(root)) return false
  if (root.status !== 'completed' || !root.params?.chain_translate) return true
  const children = related.filter((j) => j.parent_id === rootID)
  return children.length > 0 && children.every(isJobTerminal)
}
