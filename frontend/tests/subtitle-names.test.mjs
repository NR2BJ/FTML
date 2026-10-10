import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

test('자막 내려받기 이름은 긴 한국어 출처에도 확장자와 파일명 제한을 지킨다', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } })
  try {
    const { subtitleDownloadName } = await server.ssrLoadModule('/src/utils/downloadSubtitle.ts')
    assert.equal(subtitleDownloadName('Whisper 추출 (일본어)', 'vtt'), 'Whisper 추출 (일본어).vtt')
    const label = 'Gemini 번역 (한국어) ← 외부 자막 ' + '긴 원본 이름'.repeat(100) + '.cht.ass'
    const name = subtitleDownloadName(label, 'srt')
    assert.ok(Buffer.byteLength(name, 'utf8') <= 204)
    assert.ok(name.endsWith('.srt'))
    assert.ok(!name.includes('\ufffd'))
    assert.equal(subtitleDownloadName('a/b:c?d', 'ass'), 'a_b_c_d.ass')
  } finally { await server.close() }
})
