import assert from 'node:assert/strict'
import { createServer } from 'vite'
const { chromium, firefox } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from'react';import{createRoot}from'react-dom/client';
import SubtitleTaskDialog from'/src/components/Subtitles/SubtitleTaskDialog.tsx';import{useAuthStore}from'/src/stores/authStore.ts';import'/src/index.css';
useAuthStore.setState({user:{role:'admin'}});
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(SubtitleTaskDialog,{paths:['series/01.mkv'],initialMode:'generate-translate',onClose:()=>{}})));
</script></body></html>`
const server = await createServer({server:{host:'127.0.0.1',port:0},plugins:[{name:'asr-reference-fixture',configureServer(s){s.middlewares.use('/__asr.html',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__asr.html',html))})}}]})
let browser
try {
  await server.listen()
  browser = await (process.env.TEST_BROWSER==='firefox'?firefox:chromium).launch({headless:true})
  const page = await browser.newPage({viewport:{width:1280,height:1100}})
  const errors=[],submitted=[],searches=[],saved=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.route('**/api/**',async route=>{
    const p=new URL(route.request().url()).pathname
    if(!p.startsWith('/api/'))return route.continue()
    if(p==='/api/whisper/backends/available')return route.fulfill({json:[{value:'backend:1',label:'A380',type:'openvino-genai'}]})
    if(p==='/api/presets'||p==='/api/jobs/active'||p==='/api/jobs/tracked')return route.fulfill({json:[]})
    if(p.startsWith('/api/subtitle/reference-search/')){searches.push(route.request().postDataJSON());return route.fulfill({json:{scope:'series',title:'시험 작품',terms:[{original:'名前',reading:'なまえ',korean:'이름'}],songs:[{title:'노래',artist:'가수',version:'TV판 OP'}],sources:[{title:'공식 소개',url:'https://example.com/official'}]}})}
    if(p.startsWith('/api/subtitle/reference/')){if(route.request().method()==='PUT'){const data=route.request().postDataJSON();saved.push(data);return route.fulfill({json:data})}return route.fulfill({json:{scope:'series',title:'',terms:[],songs:[],sources:[]}})}
    if(p==='/api/subtitle/tasks'){submitted.push(route.request().postDataJSON());return route.fulfill({json:{items:[{path:'series/01.mkv',reason:'시험 완료'}],job_ids:[],skipped:['series/01.mkv']}})}
    throw new Error(p)
  })
  await page.goto(`${server.resolvedUrls.local[0]}__asr.html`)
  await page.getByLabel('Whisper 연결',{exact:true}).selectOption('backend:1')
  await page.getByLabel('추출 모델',{exact:true}).selectOption('Qwen/Qwen3-ASR-1.7B')
  await page.getByLabel('음성 언어',{exact:true}).selectOption('ja')
  await page.getByText('작품 이름·용어·노래 참고',{exact:true}).click()
  await page.getByLabel('참고 작품명',{exact:true}).fill('시험 작품 1기')
  await page.getByRole('button',{name:'Gemini로 용어·곡 정보 검색',exact:true}).click()
  await page.getByText('검색 결과입니다. 작품과 표기를 확인한 뒤 저장해 주세요.',{exact:true}).waitFor()
  assert.deepEqual(searches,[{title:'시험 작품 1기'}])
  assert.equal(saved.length,0,'검색 결과를 검토 없이 자동 저장하지 않는다')
  await page.getByLabel('작품 용어 사전',{exact:true}).fill('名前 | なまえ | 사용자 표기')
  await page.getByRole('button',{name:'확인한 참고 자료 저장',exact:true}).click()
  await page.getByText('저장했습니다. 이후 등록하는 같은 작품의 추출·번역에 적용됩니다.',{exact:true}).waitFor()
  assert.equal(saved[0].terms[0].korean,'사용자 표기')
  await page.getByText('확보한 가사로 특정 구간 보정 (선택)',{exact:true}).click()
  await page.getByLabel('가사 참고 사용',{exact:true}).check()
  await page.getByLabel('가사 시작 초',{exact:true}).fill('10')
  await page.getByLabel('가사 끝 초',{exact:true}).fill('80')
  await page.getByLabel('참고 가사 원문',{exact:true}).fill('시험용 가사 원문')
  await page.getByLabel(/Silero 말소리 검출 비교/).check()
  const warning=page.getByText(/로컬 OpenVINO 연결용입니다/)
  assert.equal(await warning.evaluate(el=>getComputedStyle(el).color),'rgb(146, 64, 14)')
  assert.equal(await page.getByRole('button',{name:'추출 후 번역 시작',exact:true}).evaluate(el=>getComputedStyle(el).color),'rgb(255, 255, 255)')
  await page.evaluate(()=>document.documentElement.classList.add('dark'))
  assert.equal(await warning.evaluate(el=>getComputedStyle(el).color),'rgb(251, 191, 36)')
  await page.evaluate(()=>document.documentElement.classList.remove('dark'))
  if(process.env.UI_SCREENSHOT)await page.screenshot({path:process.env.UI_SCREENSHOT,fullPage:true})
  await page.getByRole('button',{name:'추출 후 번역 시작',exact:true}).click()
  await page.getByText('제외: 시험 완료',{exact:true}).waitFor()
  assert.equal(submitted.length,1)
  assert.equal(submitted[0].generate.model,'Qwen/Qwen3-ASR-1.7B')
  assert.deepEqual(submitted[0].generate.lyrics,{start:10,end:80,text:'시험용 가사 원문'})
  assert.equal(submitted[0].generate.observe_speech,true)
  assert.deepEqual(errors,[])
  console.log('Qwen 비교 선택, 작품 검색/확인 저장, 사용자 표기, 가사 구간, VAD 관찰 전달 통과')
} finally { await browser?.close(); await server.close() }
