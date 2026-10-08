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
const { detectBrowserCodecs, detectMediaCodecs } = await loadSource('../src/utils/codec.ts')
const { buildPlaybackPlan, attemptKey, rejectAttempt } = await loadSource('../src/utils/playbackPlan.ts')
const { PlaybackStartupWatch } = await loadSource('../src/utils/playbackStartup.ts')
const { playbackDelta } = await loadSource('../src/utils/playbackMetrics.ts')
const { PlaybackHealthWatch } = await loadSource('../src/utils/playbackHealth.ts')

test('충분한 버퍼에서 지속되는 화면 누락만 디코더 대체를 요청한다', () => {
  const watch=new PlaybackHealthWatch()
  const sample={now:0,time:0,rate:1,frames:0,dropped:0,buffer:10,paused:false,seeking:false,visible:true}
  for(let n=0;n<9;n++) assert.equal(watch.check({...sample,now:n*1000,time:n,frames:n*24,dropped:n*12}),null)
  assert.equal(watch.check({...sample,now:9000,time:9,frames:216,dropped:108}),'browser')
  for(let n=0;n<25;n++) assert.equal(watch.check({...sample,now:n*1000,time:n,frames:n*24,dropped:n*12,visible:false}),null)
})
test('서버 준비 지연과 네트워크 대기를 구분하고 순간 끊김은 무시한다', () => {
  const sample={now:0,time:0,rate:1,frames:0,dropped:0,buffer:0,paused:false,seeking:false,visible:true,server:{state:'running',output_time:0,throttled:false}}
  const watch=new PlaybackHealthWatch()
  for(let n=0;n<18;n++) assert.equal(watch.check({...sample,now:n*1000}),null)
  assert.equal(watch.check({...sample,now:18000}),'slow')
  for(let n=0;n<30;n++) assert.equal(watch.check({...sample,now:n*1000,server:{...sample.server,output_time:60}}),null)
  watch.reset()
  for(let n=0;n<30;n++) assert.equal(watch.check({...sample,now:n*1000,paused:true}),null)
})

const planPresets = [{value:'original',height:1080,can_original:true,can_original_video:true}, {value:'passthrough',height:1080}, {value:'720p',height:720}, {value:'1080p',height:1080}]
const planEncoders = ['av1','hevc','h264'].map(codec => ({codec,hwaccel:'vaapi',encoder:codec+'_vaapi'})).concat([{codec:'h264',hwaccel:'',encoder:'libx264'}, {codec:'av1',hwaccel:'',encoder:'libsvtav1'}])
const planBrowser = {h264:true,hevc:true,hevc10:true,av1:true,vp9:true,aac:true}
test('자동 재생은 직접 재생, 영상 유지, 지원 GPU 코덱, CPU H.264 순서다', () => {
  const plan = buildPlaybackPlan('auto', planPresets, planEncoders, planBrowser, 'hevc', 0)
  assert.deepEqual(plan.map(a=>`${a.codec}/${a.acceleration}`), ['hevc/direct','hevc/copy','av1/hardware','av1/hybrid','hevc/hardware','hevc/hybrid','h264/hardware','h264/hybrid','h264/software','h264/software'])
  assert.equal(plan.at(-2).quality, '1080p')
  assert.equal(plan.at(-1).quality, '720p', '자동 모드에서만 최후에 해상도를 낮춘다')
  assert.equal(buildPlaybackPlan('auto',planPresets,planEncoders,planBrowser,'hevc',1)[0].acceleration,'copy')
  assert.ok(buildPlaybackPlan('720p',planPresets,planEncoders,planBrowser,'hevc',0).every(a=>a.quality==='720p'))
})
test('CPU AV1을 자동 선택하지 않고 지원하지 않는 코덱을 제외한다', () => {
  const plan=buildPlaybackPlan('auto',planPresets.filter(p=>p.value!=='passthrough').map(p=>({...p,can_original:false,can_original_video:false})),planEncoders.filter(e=>!e.hwaccel),planBrowser,'mpeg2video',0)
  assert.deepEqual(plan,[{quality:'1080p',codec:'h264',acceleration:'software'},{quality:'720p',codec:'h264',acceleration:'software'}])
  assert.ok(buildPlaybackPlan('1080p',planPresets,planEncoders,{...planBrowser,av1:false},'hevc',0).every(a=>a.codec!=='av1'))
})
test('MKV는 직접 재생 불가여도 영상 유지 후보를 보존한다', () => {
  const plan=buildPlaybackPlan('auto',planPresets.map(p=>({...p,can_original:false,can_original_video:false})),planEncoders,planBrowser,'hevc',0)
  assert.equal(plan[0].acceleration,'copy')
})
test('서버 실패는 CPU 디코딩으로, 브라우저 실패는 다른 코덱으로 넘어가며 반복하지 않는다', () => {
  const plan=buildPlaybackPlan('1080p',planPresets,planEncoders,planBrowser,'hevc',0)
  const failed=new Set()
  rejectAttempt(plan,plan[0],'server',failed)
  assert.equal(plan.find(a=>!failed.has(attemptKey(a))).acceleration,'hybrid')
  rejectAttempt(plan,plan[1],'browser',failed)
  assert.equal(plan.find(a=>!failed.has(attemptKey(a))).codec,'hevc')
  for(const a of plan) rejectAttempt(plan,a,'server',failed)
  assert.equal(plan.find(a=>!failed.has(attemptKey(a))),undefined)
})

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

test('파일의 실제 크기와 프레임으로 원활한 디코딩을 질의한다', async t => {
  const originals=Object.fromEntries(['document','MediaSource','navigator'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]))
  t.after(()=>{for(const [k,d] of Object.entries(originals)){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k]}})
  const queries=[]
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>({canPlayType:()=> 'probably'})}})
  Object.defineProperty(globalThis,'MediaSource',{configurable:true,value:{isTypeSupported:()=>true}})
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaCapabilities:{decodingInfo:async q=>{queries.push(q);return {supported:true,smooth:!q.video.contentType.includes('av01'),powerEfficient:true}}}}})
  const support=await detectMediaCodecs({width:1920,height:1080,frame_rate:'24000/1001',bit_rate:'3456789',video_codec:'hevc',streams:[{codec_type:'video',level:153}]})
  assert.equal(support.av1,false)
  assert.equal(support.hevc10,true)
  assert.ok(queries.some(q=>q.video.contentType.includes('hvc1.2.4.L153')))
  assert.ok(queries.every(q=>q.video.width===1920&&q.video.height===1080&&q.video.bitrate===3456789&&q.video.framerate===24000/1001))
  navigator.mediaCapabilities.decodingInfo=async()=>{throw new Error('API unsupported')}
  assert.equal((await detectMediaCodecs({width:640,height:360,streams:[]})).av1,true)
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
