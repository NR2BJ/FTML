export default function ExtractionDiagnostics({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object') return null
  const data = value as Record<string, unknown>
  return <div className="subtitle-extraction-diagnostics mt-1 space-y-1 text-xs text-amber-300">
    {typeof data.lyrics_error === 'string' && <p>가사 보정 미적용: {data.lyrics_error} 원 추출본으로 저장했습니다.</p>}
    {Number(data.timing_recovered_windows) > 0 && <p>정렬이 불안정했던 구간 {Number(data.timing_recovered_windows)}개를 더 짧게 나누어 다시 추출했습니다. 해당 구간의 자막 내용과 동기화를 재생하며 확인해 주세요.</p>}
    {Number(data.timing_review_words) > 0 && <p>시작·끝 시각이 같던 단어 {Number(data.timing_review_words)}개를 인접 단어와 합치거나 짧게 추정했습니다. 정확한 발화 시각이 보장되지 않으므로 재생하며 동기화를 확인해 주세요.</p>}
    {typeof data.cues_checked === 'number' && <p>Silero 비교: 자막 {data.cues_checked}개 중 말소리 검출과 겹치지 않은 구간 {Number(data.cues_outside_speech) || 0}개. 노래·작은 목소리일 수 있어 자동 삭제하지 않았습니다.</p>}
  </div>
}
