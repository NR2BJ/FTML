import assert from 'node:assert/strict'
import { createServer } from 'vite'
const { chromium, firefox } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client'; import Settings from '/src/pages/Settings.tsx'; import '/src/index.css';
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(Settings)));
</script></body></html>`
const server = await createServer({server:{host:'127.0.0.1',port:0},plugins:[{name:'settings-fixture',configureServer(s){s.middlewares.use('/__settings.html',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__settings.html',html))})}}]})
let browser
try {
  await server.listen()
  browser = await (process.env.TEST_BROWSER==='firefox'?firefox:chromium).launch({headless:true})
  const page = await browser.newPage()
  const errors=[], requests=[]
  let backends=[{id:1,name:'A380',backend_type:'openvino-genai',url:'http://whisper:8178',enabled:true,priority:0}]
  page.on('pageerror',e=>errors.push(e.message))
  await page.route('**/api/**',async route=>{
    const req=route.request(),p=new URL(req.url()).pathname
    if(!p.startsWith('/api/'))return route.continue()
    if(p==='/api/settings')return route.fulfill({json:[{key:'gemini_api_key',label:'Gemini API 키',group:'subtitle',secret:true,value:'',has_value:false}]})
    if(p==='/api/gpu/info')return route.fulfill({json:{device:'Intel Arc A380',vram_total:6*1024**3,vram_free:-1,driver:'i915'}})
    if(p==='/api/whisper/backends'&&req.method()==='GET')return route.fulfill({json:backends})
    if(p==='/api/whisper/backends'&&req.method()==='POST'){
      const data=req.postDataJSON();requests.push(data);backends.push({...data,id:2,enabled:true,priority:0});return route.fulfill({json:{id:2}})
    }
    if(p==='/api/whisper/backends/1/health')return route.fulfill({json:{ok:false,error:'음성 인식 서버 응답: 503'}})
    if(p==='/api/whisper/backends/1'&&req.method()==='PUT'){
      const data=req.postDataJSON();requests.push(data);backends[0]={...backends[0],...data};return route.fulfill({status:204})
    }
    throw new Error(`불필요한 설정 요청: ${p}`)
  })
  await page.goto(`${server.resolvedUrls.local[0]}__settings.html`)
  await page.getByText('Whisper large-v3 INT8 · 기본 모델 고정',{exact:true}).waitFor()
  await page.getByText('감지된 GPU: Intel Arc A380 · 총 VRAM 6.0 GiB',{exact:true}).waitFor()
  assert.equal(await page.locator('select').count(),0,'모델/클라우드 종류 선택 제거')
  assert.equal(await page.locator('input').count(),1,'Gemini 키만 표시')
  await page.getByRole('button',{name:'연결 확인',exact:true}).click()
  await page.getByRole('status').getByText('연결 실패: 음성 인식 서버 응답: 503',{exact:true}).waitFor()
  await page.getByRole('button',{name:'사용 중지',exact:true}).click()
  await page.getByText('A380 · 사용 안 함',{exact:true}).waitFor()
  await page.getByRole('button',{name:'수정',exact:true}).click()
  await page.getByLabel('서버 주소',{exact:true}).fill('http://new-host:8178')
  await page.getByRole('button',{name:'저장',exact:true}).click()
  await page.getByText('http://new-host:8178',{exact:true}).waitFor()
  assert.equal(await page.getByRole('status').count(),0,'주소 수정 후 옛 연결 상태 제거')
  await page.getByRole('button',{name:'로컬 연결 추가',exact:true}).click()
  await page.getByLabel('연결 이름',{exact:true}).fill('비교 서버')
  await page.getByRole('button',{name:'저장',exact:true}).click()
  await page.getByText('비교 서버 · 사용 중',{exact:true}).waitFor()
  assert.deepEqual(requests,[{enabled:false},{name:'A380',url:'http://new-host:8178'},{name:'비교 서버',url:'http://whisper:8178',backend_type:'openvino-genai'}])
  assert.deepEqual(errors,[])
  console.log('로컬 전용 설정, 고정 모델 안내, GPU 단위, 연결 검사/중지/수정/추가 통과')
} finally { await browser?.close(); await server.close() }
