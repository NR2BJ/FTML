// PLAYWRIGHT_MODULE=... TEST_BROWSER=firefox node tests/subtitle-tasks.browser.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'
const { chromium, firefox } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';
import SubtitleTaskDialog from'/src/components/Subtitles/SubtitleTaskDialog.tsx';import Jobs from'/src/pages/Jobs.tsx';
import{useAuthStore}from'/src/stores/authStore.ts';import'/src/index.css';
window.auth=useAuthStore;useAuthStore.setState({user:{role:'admin'}});
function App(){const[open,setOpen]=useState(true);const[history,setHistory]=useState(false);window.showHistory=()=>setHistory(true);
return React.createElement(MemoryRouter,null,React.createElement('main',{style:{padding:32}},history?React.createElement(Jobs):null,
open?React.createElement(SubtitleTaskDialog,{paths:['missing.mkv','season/a.mkv','season/b.mkv'],initialMode:'generate-translate',onClose:()=>setOpen(false)}):null));}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));
</script></body></html>`
const server = await createServer({ server: {host:'127.0.0.1',port:0}, plugins:[{
  name:'subtitle-tasks-fixture', configureServer(s) {
    s.middlewares.use('/__tasks.html',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__tasks.html',html))})
  }
}]})
const base = {progress:1,created_at:'2026-10-01T00:00:00Z',completed_at:'2026-10-01T00:01:00Z',params:{}}
let jobs = [
  {...base,id:'root-a',type:'transcribe',status:'completed',file_path:'season/a.mkv',params:{language:'ja',chain_translate:{target_lang:'ko'}}},
  {...base,id:'child-a',parent_id:'root-a',type:'translate',status:'pending',file_path:'season/a.mkv',progress:0,params:{subtitle_id:'generated:whisper_ja.vtt',target_lang:'ko'}},
  {...base,id:'root-b',type:'transcribe',status:'completed',file_path:'season/b.mkv',params:{language:'ja',chain_translate:{target_lang:'ko'}}},
  {...base,id:'child-b',parent_id:'root-b',type:'translate',status:'completed',file_path:'season/b.mkv'},
]
let submissions = [], retries = [], historyQueries = []
const result = {id:'generated:translate_ko_gemini.vtt',label:'한국어 번역 결과',type:'generated',format:'vtt',language:'ko'}
let subtitleEntries=[result]
let browser
try {
  await server.listen()
  browser = await (process.env.TEST_BROWSER==='firefox'?firefox:chromium).launch({headless:true})
  const page = await browser.newPage({viewport:{width:1280,height:1000}})
  const errors = []
  page.on('pageerror',e=>errors.push(e.message))
  await page.route('**/api/**',async route=>{
    const url = new URL(route.request().url())
    if(!url.pathname.startsWith('/api/'))return route.continue()
    if(url.pathname==='/api/whisper/backends/available')return route.fulfill({json:[{value:'backend:1',label:'A380 Whisper',type:'openvino-genai'}]})
    if(url.pathname==='/api/presets')return route.fulfill({json:[{id:1,name:'내 번역 지침',prompt:'인명 표기 유지'}]})
    if(url.pathname==='/api/jobs/active')return route.fulfill({json:jobs.filter(j=>j.status==='pending'||j.status==='running')})
    if(url.pathname==='/api/jobs/tracked')return route.fulfill({json:jobs})
    if(url.pathname==='/api/subtitle/tasks') {
      submissions.push(route.request().postDataJSON())
      return route.fulfill({json:{items:[{path:'missing.mkv',reason:'영상 파일을 찾을 수 없습니다'},{path:'season/a.mkv',job_id:'root-a'},{path:'season/b.mkv',job_id:'root-b'}],job_ids:['root-a','root-b'],skipped:['missing.mkv']}})
    }
    if(url.pathname==='/api/jobs/child-a/retry') {
      retries.push('child-a')
      jobs.push({...jobs.find(j=>j.id==='child-a'),id:'child-retry',retry_of:'child-a',status:'running',error:'',progress:0.2})
      return route.fulfill({json:{status:'retrying',job_id:'child-retry'}})
    }
    if(url.pathname==='/api/jobs/videos') {
      historyQueries.push(Object.fromEntries(url.searchParams))
      let items=['season/a.mkv','season/b.mkv'].map(file_path=>({file_path,total:jobs.filter(j=>j.file_path===file_path).length,active:0,completed:2,failed:file_path.endsWith('a.mkv')?1:0,last_created_at:base.created_at}))
      items=items.filter(v=>v.file_path.includes(url.searchParams.get('q')||'')&&(url.searchParams.get('status')!=='failed'||v.failed>0))
      return route.fulfill({json:{items,total:items.length,page:1,page_size:30}})
    }
    if(url.pathname==='/api/jobs/history') {
      const items=jobs.filter(j=>j.file_path===url.searchParams.get('path')).toReversed()
      return route.fulfill({json:{items,total:items.length,page:1,page_size:50}})
    }
    if(url.pathname.startsWith('/api/subtitle/list/'))return route.fulfill({json:subtitleEntries})
    if(url.pathname.startsWith('/api/subtitle/reference/'))return route.fulfill({json:{scope:'season',title:'',terms:[],songs:[],sources:[]}})
    if(url.pathname.startsWith('/api/subtitle/convert/'))return route.fulfill({body:'WEBVTT\n\n00:00.000 --> 00:01.000\n한국어\n',contentType:'text/vtt'})
    throw new Error(`예상하지 않은 요청: ${url.pathname}`)
  })
  await page.goto(`${server.resolvedUrls.local[0]}__tasks.html`)
  await page.getByLabel('Whisper 연결',{exact:true}).selectOption('backend:1')
  await page.getByLabel('음성 언어',{exact:true}).selectOption('ja')
  await page.getByLabel('번역 지침',{exact:true}).selectOption('saved:1')
  await page.getByRole('button',{name:'추출 후 번역 시작',exact:true}).click()
  await page.getByText('작업 진행 중 · 1/2개 영상',{exact:true}).waitFor()
  assert.equal(submissions.length,1)
  assert.equal(submissions[0].translate.preset,'custom')
  assert.equal(submissions[0].translate.custom_prompt,'인명 표기 유지')
  assert.equal(submissions[0].generate.language,'ja')
  const skipped = page.getByText('missing.mkv',{exact:true}).locator('..')
  assert.match(await skipped.innerText(),/제외:/)
  assert.doesNotMatch(await skipped.innerText(),/추출|번역/)
  assert.match(await page.getByText('season/a.mkv',{exact:true}).locator('..').innerText(),/추출\s*완료[\s\S]*번역\s*대기/)
  jobs=jobs.map(j=>j.id==='child-a'?{...j,status:'failed',error:'시험 번역 실패'}:j)
  await page.getByText('작업 종료 · 2/2개 영상',{exact:true}).waitFor({timeout:8000})
  await page.getByRole('button',{name:'번역 재시도',exact:true}).click()
  await page.getByText('작업 진행 중 · 1/2개 영상',{exact:true}).waitFor()
  assert.deepEqual(retries,['child-a'])
  assert.equal(submissions.length,1,'번역만 재시도할 때 추출 요청은 다시 보내지 않는다')
  jobs=jobs.map(j=>j.id==='child-retry'?{...j,status:'completed',progress:1,result:{output_path:result.id,plain_effect_fallbacks:2}}:j)
  await page.getByText('작업 종료 · 2/2개 영상',{exact:true}).waitFor({timeout:8000})
  await page.getByText('복잡한 효과 2개는 원문 효과와 일반 번역문으로 보존',{exact:true}).waitFor()
  assert.equal(jobs.find(j=>j.id==='child-a').status,'failed')
  console.log('일괄 제외 영상 매핑, 추출 후 번역 완료 판정, 번역 단계만 재시도, 저장 지침 전달 통과')

  await page.getByRole('button',{name:'자막 작업 닫기',exact:true}).click()
  await page.evaluate(()=>window.showHistory())
  await page.getByRole('button',{name:/a.mkv.*진행/}).waitFor()
  assert.equal(await page.locator('article').count(),2)
  await page.getByRole('button',{name:/a.mkv.*진행/}).click()
  await page.getByRole('heading',{name:'상세 작업 이력 · 3건'}).waitFor()
  await page.getByText('시험 번역 실패',{exact:true}).waitFor()
  await page.getByText('이전 작업 재시도',{exact:true}).waitFor()
  assert.equal(await page.getByRole('link',{name:'season/a.mkv 재생'}).getAttribute('href'),'/watch/season/a.mkv')
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button',{name:'다운로드',exact:true}).click()
  const download = await downloaded
  assert.equal(download.suggestedFilename(),'한국어 번역 결과.vtt')
  assert.equal(await download.failure(),null)
  await page.getByRole('button',{name:'이 자막 번역',exact:true}).click()
  await page.getByRole('dialog',{name:'자막 작업',exact:true}).waitFor()
  assert.equal(await page.getByLabel('번역할 자막',{exact:true}).inputValue(),result.id)
  subtitleEntries=[result,{...result,id:'generated:new.vtt',label:'방금 완료한 결과'}]
  await page.getByRole('button',{name:'자막 작업 닫기',exact:true}).click()
  await page.getByText('방금 완료한 결과 · VTT',{exact:true}).waitFor()
  if(process.env.UI_SCREENSHOT)await page.screenshot({path:process.env.UI_SCREENSHOT,fullPage:true})
  await page.getByLabel('작업한 영상 검색',{exact:true}).fill('b.mkv')
  await page.waitForFunction(()=>document.querySelectorAll('article').length===1&&document.querySelector('article').textContent.includes('b.mkv'))
  await page.getByLabel('작업한 영상 검색',{exact:true}).fill('')
  await page.getByLabel('작업 상태',{exact:true}).selectOption('failed')
  await page.waitForFunction(()=>document.querySelectorAll('article').length===1&&document.querySelector('article').textContent.includes('a.mkv'))
  assert.ok(historyQueries.some(q=>q.q==='b.mkv'))
  assert.ok(historyQueries.some(q=>q.status==='failed'))
  await page.evaluate(()=>window.auth.setState({user:{role:'viewer'}}))
  assert.equal(await page.getByRole('button',{name:'새 자막 작업',exact:true}).count(),0)
  assert.equal(await page.getByRole('button',{name:'이 자막 번역',exact:true}).count(),0)
  assert.deepEqual(errors,[])
  console.log('60초 이전 영상별 이력, 실패/재시도 보존, 검색/필터, 재생 링크, 결과 갱신/다운로드/번역, 작업 권한 없는 상태 통과')
} finally {await browser?.close();await server.close()}
