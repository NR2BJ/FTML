// PLAYWRIGHT_MODULE=... TEST_BROWSER=firefox node tests/subtitle-updates.browser.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'
const { chromium, firefox } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React,{useEffect,useState} from 'react';import{createRoot}from'react-dom/client';
import SubtitleSelector from '/src/components/Player/SubtitleSelector.tsx';
import SubtitleDisplay from '/src/components/Player/SubtitleDisplay.tsx';
import{usePlayerSubtitles}from'/src/components/Player/usePlayerSubtitles.ts';
import{usePlayerStore}from'/src/stores/playerStore.ts';import{useJobStore}from'/src/stores/jobStore.ts';
import{useAuthStore}from'/src/stores/authStore.ts';import'/src/index.css';
window.player=usePlayerStore;window.jobs=useJobStore;
useAuthStore.setState({user:{role:'admin'}});
function App(){const[path,setPath]=useState('first.mkv');window.navigate=setPath;
useEffect(()=>{usePlayerStore.setState({currentFile:path,subtitles:[],activeSubtitle:null,currentTime:1,subtitleEnabled:false})},[path]);
usePlayerSubtitles(path);
return React.createElement('div',{className:'player-container',style:{position:'relative',width:800,height:600}},
React.createElement('button',{id:'outside'},'바깥 영역'),
React.createElement(SubtitleDisplay,{path,videoRef:{current:null}}),
React.createElement('div',{style:{position:'absolute',bottom:0,right:0}},React.createElement(SubtitleSelector,{key:path})));}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));
</script></body></html>`
const server = await createServer({server:{host:'127.0.0.1',port:0},plugins:[{name:'subtitle-updates-fixture',configureServer(s){
  s.middlewares.use('/__updates.html',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__updates.html',html))})
}}]})
const source={id:'external:source.ass',label:'원본 자막',format:'ass',type:'external',language:'zh'}
const result={id:'generated:ko.vtt',label:'한국어 번역',format:'vtt',type:'generated',language:'ko'}
let entries=[source], jobs=[], text='새 한국어 자막', listRequests=0, failList=false, listDelay=0
let jobDelay=0
const conversions=[]
let browser
try {
  await server.listen()
  browser=await(process.env.TEST_BROWSER==='firefox'?firefox:chromium).launch({headless:true})
  const page=await browser.newPage()
  const errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url())
    if(!url.pathname.startsWith('/api/'))return route.continue()
    if(url.pathname==='/api/jobs/active') {
      const snapshot=JSON.stringify(jobs),delay=jobDelay
      jobDelay=0
      if(delay)await new Promise(r=>setTimeout(r,delay))
      return route.fulfill({contentType:'application/json',body:snapshot})
    }
    if(url.pathname==='/api/jobs/translate-1')return route.fulfill({json:jobs.find(j=>j.id==='translate-1')})
    if(url.pathname==='/api/jobs/tracked')return route.fulfill({json:jobs})
    if(url.pathname==='/api/presets')return route.fulfill({json:[]})
    if(url.pathname.startsWith('/api/subtitle/list/')) {
      listRequests++
      const snapshot=JSON.stringify(url.pathname.endsWith('second.mkv')?[{...source,id:'external:second.ass',label:'두 번째 영상 자막'}]:entries)
      const delay=listDelay,fail=failList;listDelay=0;failList=false
      if(delay)await new Promise(r=>setTimeout(r,delay))
      return route.fulfill({status:fail?503:200,contentType:'application/json',body:fail?'{}':snapshot})
    }
    if(url.pathname==='/api/subtitle/tasks') {
      const request=route.request().postDataJSON()
      assert.equal(request.mode,'translate')
      assert.equal(request.translate.subtitle_id,source.id)
      jobs=[{id:'translate-1',type:'translate',status:'running',file_path:'first.mkv',params:{},progress:0.1}]
      return route.fulfill({json:{items:[{path:'first.mkv',job_id:'translate-1'}],job_ids:['translate-1'],skipped:[]}})
    }
    if(url.pathname.startsWith('/api/subtitle/content/'))return route.fulfill({body:`WEBVTT\n\n00:00.000 --> 00:04.000\n${text}\n`,contentType:'text/vtt'})
    if(url.pathname.startsWith('/api/subtitle/convert/')){
      const body=route.request().postDataJSON();conversions.push(body)
      return route.fulfill({body:`download-${body.target_format}`,contentType:'application/octet-stream'})
    }
    throw Error(`예상하지 않은 요청: ${url.pathname}`)
  })
  await page.goto(`${server.resolvedUrls.local[0]}__updates.html`)
  await page.waitForFunction(()=>window.player.getState().subtitles.length===1)
  await page.getByTitle('Subtitles',{exact:true}).click()
  await page.getByTitle('Translate this subtitle',{exact:true}).click()
  assert.equal(await page.getByRole('dialog',{name:'자막 작업'}).evaluate(el=>getComputedStyle(el).color),'rgb(15, 23, 42)')
  assert.equal(await page.getByRole('dialog',{name:'자막 작업'}).evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)')
  await page.getByRole('button',{name:'자막 번역 시작',exact:true}).click()
  await page.getByRole('button',{name:'자막 작업 닫기',exact:true}).click()
  await page.waitForFunction(()=>window.jobs.getState().jobs.some(j=>j.status==='running'))
  entries=[source,result]
  jobs=[{...jobs[0],status:'completed',completed_at:'2026-10-09T00:00:01Z'}]
  await page.waitForFunction(()=>window.player.getState().subtitles.length===2,null,{timeout:8000})
  await page.getByTitle('Subtitles',{exact:true}).click()
  await page.getByRole('button',{name:/한국어 번역\s*AI/}).click()
  await page.getByText('새 한국어 자막',{exact:true}).waitFor()
  console.log('번역 창을 닫아도 3초 주기로 완료 감지, 목록 갱신 및 새 자막 선택 통과')

  // 같은 ID로 다시 생성된 파일도 재조회하되 선택은 바꾸지 않는다.
  text='같은 ID의 새 내용'
  jobs=[...jobs,{id:'translate-2',type:'translate',file_path:'first.mkv',status:'completed',completed_at:'2026-10-09T00:00:02Z'}]
  await page.evaluate(()=>window.jobs.getState().fetchActiveJobs())
  await page.getByText(text,{exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>window.player.getState().activeSubtitle),result.id)
  let before=listRequests
  await page.evaluate(()=>window.jobs.getState().fetchActiveJobs())
  await page.waitForTimeout(150)
  assert.equal(listRequests,before,'이미 처리한 완료 작업은 다시 읽지 않음')
  jobs.push({id:'other',type:'translate',file_path:'other.mkv',status:'completed',completed_at:'2026-10-09T00:00:03Z'})
  await page.evaluate(()=>window.jobs.getState().fetchActiveJobs())
  assert.equal(listRequests,before,'다른 영상의 완료 작업은 무시')

  failList=true;text='재시도 후 내용'
  jobs.push({id:'retry',type:'transcribe',file_path:'first.mkv',status:'completed',completed_at:'2026-10-09T00:00:04Z'})
  await page.evaluate(()=>window.jobs.getState().fetchActiveJobs())
  await page.getByText(text,{exact:true}).waitFor({timeout:8000})
  console.log('같은 ID 내용 재조회, 선택 유지, 중복/무관한 작업 무시, 목록 요청 실패 후 재시도 통과')

  // 늦게 온 작업 조회가 최신 완료 상태를 실행 중으로 되돌리지 않는다.
  jobs=[{id:'late',status:'running',file_path:'other.mkv',type:'translate'}];jobDelay=600
  await page.evaluate(()=>{window.oldJobs=window.jobs.getState().fetchActiveJobs()})
  await page.waitForTimeout(100)
  jobs=[{...jobs[0],status:'completed'}]
  await page.evaluate(()=>window.jobs.getState().fetchActiveJobs())
  await page.evaluate(()=>window.oldJobs)
  assert.equal(await page.evaluate(()=>window.jobs.getState().jobs[0].status),'completed')

  // 실제 클릭과 다운로드 이벤트로 원본 ASS 및 변환 파일을 확인한다.
  await page.getByTitle('Subtitles',{exact:true}).click()
  for(const format of ['ass','srt','vtt']) {
    await page.getByRole('button',{name:'원본 자막 다운로드 형식',exact:true}).click()
    const item=page.getByRole('menuitem',{name:format==='ass'?'ASS (원본)':format.toUpperCase(),exact:true})
    await item.hover()
    await page.waitForTimeout(250)
    assert.equal(await item.isVisible(),true)
    assert.equal(await item.evaluate(el=>getComputedStyle(el).color),'rgb(241, 245, 249)')
    if(format==='ass' && process.env.UI_SCREENSHOT)await page.screenshot({path:process.env.UI_SCREENSHOT})
    const downloaded=page.waitForEvent('download')
    await item.click()
    const download=await downloaded
    assert.equal(download.suggestedFilename(),`원본 자막.${format}`)
    const stream=await download.createReadStream();const chunks=[]
    for await(const chunk of stream)chunks.push(chunk)
    assert.equal(Buffer.concat(chunks).toString(),`download-${format}`)
    assert.equal(await download.failure(),null)
  }
  assert.deepEqual(conversions.map(c=>c.target_format),['ass','srt','vtt'])
  console.log('마우스 이동에도 목록 유지, ASS 원본/SRT/VTT 클릭 다운로드와 파일 내용 확인 통과')

  // 첫 영상의 느린 응답이 다음 영상 목록을 덮지 않는다.
  listDelay=700;before=listRequests
  await page.evaluate(()=>window.player.getState().requestSubtitleRefresh('first.mkv'))
  while(listRequests===before)await page.waitForTimeout(20)
  await page.evaluate(()=>window.navigate('second.mkv'))
  await page.waitForFunction(()=>window.player.getState().subtitles[0]?.label==='두 번째 영상 자막')
  await page.waitForTimeout(850)
  assert.equal(await page.evaluate(()=>window.player.getState().subtitles[0].label),'두 번째 영상 자막')
  assert.deepEqual(errors,[])
  console.log('이전 영상의 늦은 응답 차단 및 늦은 작업 조회의 상태 되돌림 방지 통과')
} finally { await browser?.close();await server.close() }
