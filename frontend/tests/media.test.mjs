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
const { compatibleQuality, canTryCompatibility } = await loadSource('../src/utils/playback.ts')
const { detectBrowserCodecs } = await loadSource('../src/utils/codec.ts')
const { PlaybackStartupWatch } = await loadSource('../src/utils/playbackStartup.ts')
const { playbackDelta } = await loadSource('../src/utils/playbackMetrics.ts')

test('표시 프레임과 재생 진행률은 최근 실제 경과 시간으로 계산한다', () => {
  const sample = { wallTime: 1000, mediaTime: 600, totalFrames: 240, droppedFrames: 2, playbackRate: 1 }
  assert.equal(playbackDelta(null, sample), null)
  assert.deepEqual(playbackDelta(sample, { ...sample, wallTime: 2000, mediaTime: 601, totalFrames: 264, droppedFrames: 4 }),
    { displayedFPS: 22, mediaSpeed: 1, droppedFrames: 2 })
  assert.deepEqual(playbackDelta(sample, { ...sample, wallTime: 2000 }),
    { displayedFPS: 0, mediaSpeed: 0, droppedFrames: 0 })
  assert.deepEqual(playbackDelta({ ...sample, playbackRate: 2 }, { ...sample, wallTime: 2000, mediaTime: 602, totalFrames: 288, playbackRate: 2 }),
    { displayedFPS: 48, mediaSpeed: 2, droppedFrames: 0 })
})

test('탐색과 배속 변경, 소스 교체, 절전은 재생 속도 측정에서 제외한다', () => {
  const previous = { wallTime: 1000, mediaTime: 10, totalFrames: 240, droppedFrames: 2, playbackRate: 1 }
  const current = { ...previous, wallTime: 2000, mediaTime: 11, totalFrames: 264 }
  for (const change of [{ mediaTime: 1 }, { mediaTime: 600 }, { totalFrames: 10 }, { droppedFrames: 0 }, { wallTime: 10000 }, { wallTime: 1000 }, { playbackRate: 2 }, { mediaTime: NaN }]) {
    assert.equal(playbackDelta(previous, { ...current, ...change }), null)
  }
})

test('재생 시작 감시는 영상 준비를 기다리고 오류 없는 멈춤을 구분한다', () => {
  const watch = new PlaybackStartupWatch()
  assert.equal(watch.check(100000, 1, true), 'waiting', '첫 영상 도착 전 대기는 포함하지 않는다')
  for (let t = 100500; t < 108000; t += 500) assert.equal(watch.check(t, 1, true), 'waiting')
  assert.equal(watch.check(108000, 1, true), 'stalled')
  assert.equal(watch.check(108500, 2, true), 'ready', '일시정지 상태라도 첫 화면이 준비되면 정상이다')
})

test('숨겨진 탭과 절전 시간은 재생 실패로 세지 않는다', () => {
  const watch = new PlaybackStartupWatch()
  for (let t = 0; t <= 7000; t += 500) assert.equal(watch.check(t, 1, true), 'waiting')
  assert.equal(watch.check(7500, 1, false), 'waiting')
  assert.equal(watch.check(8000, 1, true), 'waiting')
  assert.equal(watch.check(60000, 1, true), 'waiting')
  for (let t = 60500; t < 68000; t += 500) assert.equal(watch.check(t, 1, true), 'waiting')
  assert.equal(watch.check(68000, 1, true), 'stalled')
  assert.equal(watch.check(68500, 3, false), 'ready')
})

test('HLS 코덱은 MP4 MSE와 HEVC Main 10을 따로 검사한다', t => {
  const checked = []
  const originals = Object.fromEntries(['document', 'MediaSource'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  t.after(() => {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  Object.defineProperty(globalThis, 'document', {configurable:true, value:{createElement:() => ({canPlayType:() => 'probably'})}})
  Object.defineProperty(globalThis, 'MediaSource', {configurable:true, value:{isTypeSupported:mime => {
    checked.push(mime)
    return mime.includes('hvc1.1.') || mime.includes('avc1.')
  }}})
  const codecs = detectBrowserCodecs()
  assert.equal(codecs.hevc, true)
  assert.equal(codecs.hevc10, false)
  assert.equal(codecs.av1, false, '원본 파일 지원으로 MSE 미지원을 덮어쓰지 않는다')
  assert.equal(codecs.vp9, false)
  assert.ok(checked.includes('video/mp4; codecs="vp09.00.10.08"'))
  delete globalThis.MediaSource
  assert.equal(detectBrowserCodecs().hevc10, true, 'MSE가 없으면 네이티브 지원 여부를 사용한다')
})

test('호환 변환은 원본 전송 대신 같은 해상도를 선택하고 한 번만 시도한다', () => {
  const presets = [{value:'1080p',height:1080}, {value:'original',height:2160}, {value:'passthrough',height:2160}, {value:'720p',height:720}]
  assert.equal(compatibleQuality('passthrough', presets), '1080p')
  assert.equal(compatibleQuality('original', presets), '1080p')
  assert.equal(compatibleQuality('720p', presets), '720p')
  assert.equal(compatibleQuality('passthrough', []), '720p')
  assert.equal(canTryCompatibility('passthrough', 'h264', false), true)
  assert.equal(canTryCompatibility('original', 'h264', false), true)
  assert.equal(canTryCompatibility('1080p', 'av1', false), true)
  assert.equal(canTryCompatibility('1080p', 'h264', false), false)
  assert.equal(canTryCompatibility('passthrough', 'av1', true), false)
})

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
