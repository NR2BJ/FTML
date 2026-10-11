import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

test('정렬 복구 안내는 복구한 작업에만 표시하고 기존 진단도 보존한다', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } })
  try {
    const { default: Diagnostics } = await server.ssrLoadModule('/src/components/Subtitles/ExtractionDiagnostics.tsx')
    const render = value => renderToStaticMarkup(createElement(Diagnostics, { value }))
    assert.equal(render(null), '')
    assert.doesNotMatch(render({ timing_recovered_windows: 0 }), /다시 추출/)
    const html = render({ timing_recovered_windows: 2, timing_review_words: 3, cues_checked: 10, cues_outside_speech: 1 })
    assert.match(html, /구간 2개를 더 짧게 나누어 다시 추출/)
    assert.match(html, /단어 3개/)
    assert.match(html, /Silero 비교/)
    assert.match(html, /동기화를 재생하며 확인/)
    assert.match(render({ timing_adjusted_onsets: 2 }), /단어 2개의 시작 시각/)
    assert.doesNotMatch(render({ timing_adjusted_onsets: 0 }), /시작 시각/)
    assert.match(render({ timing_adjusted_prefixes: 2 }), /2개 구간의 표시 시작/)
    assert.doesNotMatch(render({ timing_adjusted_prefixes: 0 }), /문장 앞의 여러 글자/)
    assert.match(render({ timing_realignment_attempts: 3, timing_realigned_sentences: 2 }), /3회 시간 정렬하여 2개 문장/)
    assert.match(render({ timing_realignment_attempts: 1 }), /0개 문장에 반영/)
    assert.doesNotMatch(render({ timing_realignment_attempts: 0 }), /원문 그대로/)
    assert.match(render({ timing_context_repaired_sentences: 2 }), /2개 문장은 서로 다른 음성 범위/)
    assert.match(render({ timing_context_repaired_sentences: 2 }), /불확실한 끝부분을 보완/)
    assert.match(render({ timing_context_repaired_sentences: 2 }), /이름 인식 오류까지 고친 것은 아닙니다/)
    assert.doesNotMatch(render({ timing_context_repaired_sentences: 0 }), /불확실한 끝부분/)
    assert.match(render({ speech_boundaries_available: false }), /원래 시각을 유지/)
    assert.doesNotMatch(render({ speech_boundaries_available: true }), /원래 시각을 유지/)
    const acoustic = render({ timing_acoustic_accepted: 4, timing_acoustic_skipped: 2 })
    assert.match(acoustic, /음향 대조\(실험\)/)
    assert.match(acoustic, /4개 발언의 시각·묶음/)
    assert.match(acoustic, /인식 문구는 바꾸지 않았/)
    assert.match(acoustic, /구간 2개는 기존 시각을 유지/)
    assert.match(render({ timing_acoustic_accepted: 0 }), /0개 발언/)
    assert.match(render({ timing_acoustic_unavailable: true }), /기존 추출 시각으로 저장/)
    assert.doesNotMatch(render({}), /음향 대조/)
  } finally {
    await server.close()
  }
})
