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
  const errors=[],submitted=[],saved=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.route('**/api/**',async route=>{
    const p=new URL(route.request().url()).pathname
    if(!p.startsWith('/api/'))return route.continue()
    if(p==='/api/whisper/backends/available')return route.fulfill({json:[{value:'backend:1',label:'A380',type:'openvino-genai'}]})
    if(p==='/api/presets'||p==='/api/jobs/active'||p==='/api/jobs/tracked')return route.fulfill({json:[]})
    if(p.startsWith('/api/subtitle/reference/')){if(route.request().method()==='PUT'){const data=route.request().postDataJSON();saved.push(data);return route.fulfill({json:data})}return route.fulfill({json:{scope:'series',title:'',terms:[],songs:[],sources:[]}})}
    if(p==='/api/subtitle/tasks'){submitted.push(route.request().postDataJSON());return route.fulfill({json:{items:[{path:'series/01.mkv',reason:'시험 완료'}],job_ids:[],skipped:['series/01.mkv']}})}
    throw new Error(p)
  })
  await page.goto(`${server.resolvedUrls.local[0]}__asr.html`)
  await page.getByLabel('로컬 음성 인식 연결',{exact:true}).selectOption('backend:1')
  assert.equal(await page.getByLabel('추출 모델',{exact:true}).inputValue(),'OpenVINO/whisper-large-v3-int8-ov')
  assert.equal(await page.getByLabel('추출 모델',{exact:true}).locator('option').count(),2)
  await page.getByLabel('추출 모델',{exact:true}).selectOption('Qwen/Qwen3-ASR-1.7B')
  await page.getByLabel('음성 언어',{exact:true}).selectOption('ja')
  await page.getByText('작품 용어 사전 (선택)',{exact:true}).click()
  await page.getByLabel('참고 작품명',{exact:true}).fill('시험 작품 1기')
  await page.getByLabel('작품 용어 사전',{exact:true}).fill('名前 | なまえ | 사용자 표기')
  await page.getByRole('button',{name:'확인한 참고 자료 저장',exact:true}).click()
  await page.getByText('저장했습니다. 이후 등록하는 같은 작품의 추출·번역에 적용됩니다.',{exact:true}).waitFor()
  assert.equal(saved[0].terms[0].korean,'사용자 표기')
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
  assert.equal(submitted[0].generate.lyrics,undefined)
  assert.equal(submitted[0].generate.observe_speech,true)
  assert.deepEqual(errors,[])
  console.log('두 추출 모델 선택, 용어 사전 저장, 가사 입력 제거, VAD 관찰 전달 통과')
} finally { await browser?.close(); await server.close() }
