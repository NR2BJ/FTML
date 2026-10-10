import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

test('정렬 복구 안내는 복구한 작업에만 표시하고 기존 진단도 보존한다', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } })
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
  } finally {
    await server.close()
  }
})
