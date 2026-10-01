import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

async function loadSource(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } })
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
}

const { parseVTT } = await loadSource('../src/utils/subtitles.ts')
const { encodeMediaPath } = await loadSource('../src/utils/mediaPath.ts')
const { createSessionID, normalizeSeekTime } = await loadSource('../src/utils/session.ts')

test('Windows 줄바꿈과 BOM이 있는 자막을 분리한다', () => {
  const cues = parseVTT('\uFEFFWEBVTT\r\n\r\n1\r\n00:00:01.000 --> 00:00:02.000\r\n첫째\r\n\r\n2\r\n00:00:03.000 --> 00:00:04.000\r\n둘째\r\n')
  assert.deepEqual(cues, [{ start: 1, end: 2, text: '첫째' }, { start: 3, end: 4, text: '둘째' }])
})

test('주석과 잘못된 시간은 자막으로 표시하지 않는다', () => {
  const cues = parseVTT('WEBVTT\n\nNOTE test\n00:00:00.000 --> 00:00:09.000\ncomment\n\n00:03.000 --> 00:02.000\nbackwards\n\n00:04.000 --> 00:05.000 align:start\n<i>정상</i>\n다음 줄')
  assert.deepEqual(cues, [{ start: 4, end: 5, text: '정상\n다음 줄' }])
})

test('경로 구분자는 유지하고 파일명의 특수문자는 보존한다', () => {
  const path = '애니 100%/episode #1?%20.mp4'
  const url = new URL(`https://example.test/${encodeMediaPath(path)}`)
  assert.equal(url.search, '')
  assert.equal(url.hash, '')
  assert.equal(decodeURIComponent(url.pathname.slice(1)), path)
})

test('재생 작업은 매번 별도 번호를 사용하고 밀리초 탐색을 유지한다', () => {
  const ids = Array.from({ length: 1000 }, createSessionID)
  assert.equal(new Set(ids).size, 1000)
  assert.ok(ids.every((id) => /^[a-f0-9]{32}$/.test(id)))
  assert.equal(normalizeSeekTime(123.45649), 123.456)
  assert.equal(normalizeSeekTime(-1), 0)
  assert.equal(normalizeSeekTime(NaN), 0)
})
