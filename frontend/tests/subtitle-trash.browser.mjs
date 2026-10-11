import assert from 'node:assert/strict'
import { createServer } from 'vite'
const { chromium, firefox } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from'react';import{createRoot}from'react-dom/client';import'/src/index.css';
import SubtitleSelector from'/src/components/Player/SubtitleSelector.tsx';
import{usePlayerSubtitles}from'/src/components/Player/usePlayerSubtitles.ts';
import{useAuthStore}from'/src/stores/authStore.ts';import{usePlayerStore}from'/src/stores/playerStore.ts';
window.player=usePlayerStore;useAuthStore.setState({user:{role:'admin'}});usePlayerStore.setState({currentFile:'a.mkv'});
function App(){usePlayerSubtitles('a.mkv');return React.createElement('div',{className:'player-container',style:{height:600,width:800,position:'relative',background:'#111'}},
React.createElement('button',{id:'outside'},'닫기 영역'),React.createElement('div',{style:{position:'absolute',right:20,bottom:20}},React.createElement(SubtitleSelector)));}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));
</script></body></html>`
const server=await createServer({server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'trash-fixture',configureServer(s){
  s.middlewares.use('/__trash.html',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__trash.html',html))})
}}]})
const sub={id:'generated:whisper_ja.vtt',label:'Whisper 추출 (일본어)',type:'generated',language:'ja',format:'vtt'}
let entries=[sub], trash=[], deletes=0, restores=0, browser
try {
  await server.listen()
  browser=await(process.env.TEST_BROWSER==='firefox'?firefox:chromium).launch({headless:true})
  const page=await browser.newPage({viewport:{width:1000,height:800}}), errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  page.on('dialog',()=>{throw Error('삭제 확인창이 열림')})
  await page.route('**/api/**', async route=>{
    const p=new URL(route.request().url()).pathname
    if(!p.startsWith('/api/'))return route.continue()
    if(p==='/api/jobs/active')return route.fulfill({json:[]})
    if(p.startsWith('/api/subtitle/list/'))return route.fulfill({json:entries})
    if(p.startsWith('/api/subtitle/trash/'))return route.fulfill({json:trash})
    if(p.startsWith('/api/subtitle/delete/')) {
      deletes++;await new Promise(r=>setTimeout(r,200));entries=[]
      trash=[{id:'trash-1',filename:'whisper_ja.vtt',label:sub.label,deleted_at:'2026-10-11T06:00:00Z'}]
      return route.fulfill({status:204})
    }
    if(p.startsWith('/api/subtitle/restore/')) {
      restores++;await new Promise(r=>setTimeout(r,200));entries=[sub];trash=[]
      return route.fulfill({json:{id:sub.id}})
    }
    throw Error(p)
  })
  await page.goto(`${server.resolvedUrls.local[0]}__trash.html`)
  await page.waitForFunction(()=>window.player.getState().subtitles.length===1)
  await page.evaluate(id=>window.player.setState({activeSubtitle:id,secondarySubtitle:id}),sub.id)
  await page.getByTitle('Subtitles',{exact:true}).click()
  await page.getByTitle('휴지통으로 이동',{exact:true}).click()
  await page.locator('#outside').click()
  await page.waitForFunction(()=>window.player.getState().subtitles.length===0)
  assert.equal(await page.evaluate(()=>window.player.getState().activeSubtitle),null)
  assert.equal(await page.evaluate(()=>window.player.getState().secondarySubtitle),null)
  await page.getByTitle('Subtitles',{exact:true}).click()
  await page.getByRole('button',{name:'자막 휴지통',exact:true}).click()
  await page.getByRole('button',{name:'복구',exact:true}).waitFor()
  const dialog=page.getByRole('dialog',{name:'자막 휴지통',exact:true})
  assert.equal(await dialog.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)')
  assert.equal(await dialog.evaluate(el=>getComputedStyle(el).color),'rgb(15, 23, 42)')
  await page.screenshot({path:`/tmp/ftml-trash-${process.env.TEST_BROWSER||'chromium'}-light.png`})
  await page.evaluate(()=>document.documentElement.classList.add('dark'))
  assert.equal(await dialog.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(15, 23, 42)')
  assert.equal(await dialog.evaluate(el=>getComputedStyle(el).color),'rgb(255, 255, 255)')
  await page.getByRole('button',{name:'복구',exact:true}).click()
  await page.locator('#outside').click()
  await page.waitForFunction(()=>window.player.getState().subtitles.length===1)
  assert.equal(deletes,1);assert.equal(restores,1)
  assert.deepEqual(errors,[])
  console.log('재생기 즉시 삭제, 창을 닫아도 목록/주·보조 자막 갱신, 휴지통 복구, 밝은/어두운 테마 통과')
} finally {await browser?.close();await server.close()}
