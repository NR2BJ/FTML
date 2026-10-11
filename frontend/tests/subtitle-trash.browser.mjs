import assert from 'node:assert/strict'
import { createServer } from 'vite'
const { chromium, firefox } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from'react';import{createRoot}from'react-dom/client';import'/src/index.css';
import SubtitleSelector from'/src/components/Player/SubtitleSelector.tsx';import Settings from'/src/pages/Settings.tsx';
import{usePlayerSubtitles}from'/src/components/Player/usePlayerSubtitles.ts';
import{useAuthStore}from'/src/stores/authStore.ts';import{usePlayerStore}from'/src/stores/playerStore.ts';
window.player=usePlayerStore;useAuthStore.setState({user:{role:'admin'}});usePlayerStore.setState({currentFile:'a.mkv'});
function App(){usePlayerSubtitles('a.mkv');const[settings,setSettings]=React.useState(false);return React.createElement(React.Fragment,null,
React.createElement('button',{id:'settings',onClick:()=>setSettings(!settings)},'전체 설정'),
settings?React.createElement(Settings):React.createElement('div',{className:'player-container',style:{height:500,width:800,position:'relative',background:'#111'}},
React.createElement('button',{id:'outside'},'닫기 영역'),React.createElement('div',{style:{position:'absolute',right:20,bottom:20}},React.createElement(SubtitleSelector))));}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));
</script></body></html>`
const server=await createServer({server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'trash-fixture',configureServer(s){
  s.middlewares.use('/__trash.html',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__trash.html',html))})
}}]})
const sub={id:'generated:whisper_ja.vtt',label:'Whisper 추출 (일본어)',type:'generated',language:'ja',format:'vtt'}
let entries=[sub], trash=[{id:'other',storage_key:'bbbbbbbbbbbbbbbb',video_path:'folder/b.mkv',filename:'b.ass',label:'Gemini 번역 ← 중국어 ASS',deleted_at:'2026-10-01T00:00:00Z'}]
let deletes=0, restores=0, retention='', conflict=true, browser
try {
  await server.listen()
  browser=await(process.env.TEST_BROWSER==='firefox'?firefox:chromium).launch({headless:true})
  const page=await browser.newPage({viewport:{width:1000,height:950}}), errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  page.on('dialog',()=>{throw Error('삭제 확인창이 열림')})
  await page.route('**/api/**', async route=>{
    const req=route.request(), url=new URL(req.url()), p=url.pathname
    if(!p.startsWith('/api/'))return route.continue()
    if(p==='/api/jobs/active'||p==='/api/whisper/backends')return route.fulfill({json:[]})
    if(p==='/api/gpu/info')return route.fulfill({json:{device:'A380',vram_total:6*1024**3,vram_free:-1}})
    if(p==='/api/settings') {
      if(req.method()==='PUT') {retention=req.postDataJSON().subtitle_trash_retention_days;return route.fulfill({status:204})}
      return route.fulfill({json:[{key:'subtitle_trash_retention_days',label:'자막 휴지통 자동 비우기',group:'subtitle',value:retention,secret:false,has_value:!!retention}]})
    }
    if(p.startsWith('/api/subtitle/list/'))return route.fulfill({json:entries})
    if(p==='/api/subtitle/trash')return route.fulfill({json:trash})
    if(p.startsWith('/api/subtitle/delete/')) {
      deletes++;await new Promise(r=>setTimeout(r,200));entries=[]
      trash.push({id:'trash-1',storage_key:'aaaaaaaaaaaaaaaa',video_path:'a.mkv',filename:'whisper_ja.vtt',label:sub.label,deleted_at:'2026-10-11T06:00:00Z'})
      return route.fulfill({status:204})
    }
    if(p==='/api/subtitle/trash/restore') {
      assert.equal(url.searchParams.get('storage_key'),'aaaaaaaaaaaaaaaa')
      if(conflict)return route.fulfill({status:409,json:{error:'같은 이름의 자막이 있습니다.'}})
      restores++;await new Promise(r=>setTimeout(r,200));entries=[sub];trash=trash.filter(s=>s.id!==url.searchParams.get('id'))
      return route.fulfill({json:{id:sub.id,video_path:'a.mkv'}})
    }
    throw Error(p)
  })
  await page.goto(`${server.resolvedUrls.local[0]}__trash.html`)
  await page.waitForFunction(()=>window.player.getState().subtitles.length===1)
  await page.evaluate(id=>window.player.setState({activeSubtitle:id,secondarySubtitle:id}),sub.id)
  await page.getByTitle('Subtitles',{exact:true}).click()
  assert.equal(await page.getByRole('button',{name:'자막 휴지통',exact:true}).count(),0)
  await page.getByTitle('휴지통으로 이동',{exact:true}).click()
  await page.locator('#outside').click()
  await page.waitForFunction(()=>window.player.getState().subtitles.length===0)
  assert.equal(await page.evaluate(()=>window.player.getState().activeSubtitle),null)
  assert.equal(await page.evaluate(()=>window.player.getState().secondarySubtitle),null)
  await page.locator('#settings').click()
  const section=page.getByRole('region',{name:'전체 자막 휴지통'})
  await section.getByText('a.mkv',{exact:true}).waitFor()
  await section.getByText('folder/b.mkv',{exact:true}).waitFor()
  const select=page.getByLabel('자막 휴지통 자동 비우기',{exact:true})
  assert.equal(await select.inputValue(),'0')
  assert.deepEqual(await select.locator('option').evaluateAll(options=>options.map(o=>o.value)),['0','7','15','30'])
  for(const days of ['7','15','30','0']) {
    await select.selectOption(days)
    await page.getByRole('button',{name:'Save Settings',exact:true}).click()
    await page.getByRole('button',{name:'Saved!',exact:true}).waitFor()
    assert.equal(retention,days)
    await page.getByRole('button',{name:'Save Settings',exact:true}).waitFor()
  }
  await page.getByLabel('휴지통 검색').fill('a.mkv')
  assert.equal(await section.getByRole('button',{name:'복구',exact:true}).count(),1)
  await section.getByRole('button',{name:'복구',exact:true}).click()
  await section.getByRole('alert').filter({hasText:'같은 이름'}).waitFor()
  assert.equal(trash.length,2)
  await page.screenshot({path:`/tmp/ftml-global-trash-${process.env.TEST_BROWSER||'chromium'}.png`})
  conflict=false
  await section.getByRole('button',{name:'복구',exact:true}).click()
  await page.locator('#settings').click()
  await page.waitForFunction(()=>window.player.getState().subtitles.length===1)
  await page.locator('#settings').click()
  await section.getByText('folder/b.mkv',{exact:true}).waitFor()
  assert.equal(await section.getByText('a.mkv',{exact:true}).count(),0)
  assert.equal(deletes,1);assert.equal(restores,1)
  assert.deepEqual(errors,[])
  console.log('전체 설정의 여러 영상 휴지통·검색·충돌 보존·복구, 7/15/30일 저장, 화면 이탈 후 재생기 갱신 통과')
} finally {await browser?.close();await server.close()}
