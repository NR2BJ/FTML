export default function ExtractionDiagnostics({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object') return null
  const data = value as Record<string, unknown>
  return <div className="subtitle-extraction-diagnostics mt-1 space-y-1 text-xs text-amber-300">
    {Number(data.timing_adjusted_onsets) > 0 && <p>긴 선행 무음이 붙은 단어 {Number(data.timing_adjusted_onsets)}개의 시작 시각을 말소리 경계와 대조해 보정했습니다. 대사와 원음은 삭제하지 않았습니다.</p>}
    {Number(data.timing_adjusted_prefixes) > 0 && <p>문장 앞의 여러 글자에 무음이 나뉘어 붙은 {Number(data.timing_adjusted_prefixes)}개 구간의 표시 시작을 보정했습니다. 문구는 유지했으며 재생하며 동기화를 확인해 주세요.</p>}
    {data.speech_boundaries_available === false && <p>말소리 경계를 확인하지 못해 Whisper의 원래 시각을 유지했습니다.</p>}
    {typeof data.lyrics_error === 'string' && <p>가사 보정 미적용: {data.lyrics_error} 원 추출본으로 저장했습니다.</p>}
    {Number(data.timing_recovered_windows) > 0 && <p>정렬이 불안정했던 구간 {Number(data.timing_recovered_windows)}개를 더 짧게 나누어 다시 추출했습니다. 해당 구간의 자막 내용과 동기화를 재생하며 확인해 주세요.</p>}
    {Number(data.timing_realignment_attempts) > 0 && <p>Qwen의 불확실한 문장을 원문 그대로 {Number(data.timing_realignment_attempts)}회 시간 정렬하여 {Number(data.timing_realigned_sentences) || 0}개 문장에 반영했습니다. 나머지는 기존 시각을 유지했습니다. 실제 동기화 확인은 필요합니다.</p>}
    {Number(data.timing_context_repaired_sentences) > 0 && <p>그중 {Number(data.timing_context_repaired_sentences)}개 문장은 서로 다른 음성 범위에서 시각을 대조하고, 불확실한 끝부분을 한 표시 단위로 묶었습니다. 원문은 유지했으며 이름 인식 오류까지 고친 것은 아닙니다.</p>}
    {Number(data.timing_review_words) > 0 && <p>시작·끝 시각이 같던 단어 {Number(data.timing_review_words)}개를 인접 단어와 합치거나 짧게 추정했습니다. 정확한 발화 시각이 보장되지 않으므로 재생하며 동기화를 확인해 주세요.</p>}
    {typeof data.cues_checked === 'number' && <p>Silero 비교: 자막 {data.cues_checked}개 중 말소리 검출과 겹치지 않은 구간 {Number(data.cues_outside_speech) || 0}개. 노래·작은 목소리일 수 있어 자동 삭제하지 않았습니다.</p>}
  </div>
}
