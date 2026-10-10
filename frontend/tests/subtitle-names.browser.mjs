import assert from 'node:assert/strict'
import { createServer } from 'vite'
const { chromium, firefox } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const entries = [
  { id: 'generated:whisper_ja.vtt', label: 'Whisper 추출 (일본어)', type: 'generated', language: 'ja', format: 'vtt' },
  { id: 'generated:qwen3_ja_1_7b_track1.vtt', label: 'Qwen 추출 (일본어 · 1.7B · 트랙 1)', type: 'generated', language: 'ja', format: 'vtt' },
  { id: 'generated:translate_ko_gemini_example.ass', label: 'Gemini 번역 (한국어) ← 외부 자막 [Example-Group] Long_Original_Subtitle_Name_Episode_01_1080p_x265.cht.ass', type: 'generated', language: 'ko', format: 'ass' },
]
const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React,{useState}from'react';import{createRoot}from'react-dom/client';import'/src/index.css';
import Selector from'/src/components/Player/SubtitleSelector.tsx';
import Manager from'/src/components/Browse/SubtitleManagerDialog.tsx';
import{usePlayerStore}from'/src/stores/playerStore.ts';import{useAuthStore}from'/src/stores/authStore.ts';
window.player=usePlayerStore;useAuthStore.setState({user:{role:'admin'}});
usePlayerStore.setState({currentFile:'episode.mkv',subtitles:${JSON.stringify(entries)}});
function App(){const[manager,setManager]=useState(false);return React.createElement('div',{style:{position:'relative',width:900,height:720}},
React.createElement('button',{id:'manager',onClick:()=>setManager(true)},'자막 관리'),
React.createElement('div',{className:'player-container',style:{position:'absolute',right:10,bottom:10}},React.createElement(Selector)),
manager&&React.createElement(Manager,{file:{path:'episode.mkv',name:'episode.mkv'},onClose:()=>setManager(false),onTranslate:()=>{}}));}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`
const server = await createServer({ server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'subtitle-names',configureServer(s){
  s.middlewares.use('/__names.html',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__names.html',html))})
}}]})
let browser
try {
  await server.listen()
  browser = await (process.env.TEST_BROWSER==='firefox'?firefox:chromium).launch({headless:true})
  const page = await browser.newPage({viewport:{width:1100,height:820}})
  const errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.route('**/api/subtitle/list/**',route=>route.fulfill({json:entries}))
  await page.route('**/api/subtitle/convert/**',route=>route.fulfill({body:'subtitle-content',contentType:'application/octet-stream'}))
  await page.goto(`${server.resolvedUrls.local[0]}__names.html`)
  await page.getByTitle('Subtitles',{exact:true}).click()
  const named = page.getByTitle(entries[2].label,{exact:true})
  await named.waitFor()
  assert.equal(await named.evaluate(el=>el.scrollWidth<=el.clientWidth),true)
  assert.equal(await named.evaluate(el=>getComputedStyle(el).color),'rgb(209, 213, 219)')
  await page.getByRole('button',{name:`${entries[2].label} 다운로드 형식`,exact:true}).click()
  const event=page.waitForEvent('download')
  await page.getByRole('menuitem',{name:'SRT',exact:true}).click()
  const download=await event
  assert.match(download.suggestedFilename(),/^Gemini 번역/)
  assert.ok(download.suggestedFilename().endsWith('.srt'))
  assert.equal(await download.failure(),null)
  await named.click()
  assert.equal(await page.evaluate(()=>window.player.getState().activeSubtitle),entries[2].id)
  await page.locator('#manager').click()
  for(const item of entries) {
    const label=page.getByTitle(item.label,{exact:true})
    await label.waitFor()
    assert.equal(await label.evaluate(el=>el.scrollWidth<=el.clientWidth),true)
    assert.equal(await label.evaluate(el=>getComputedStyle(el).color),'rgb(51, 65, 85)')
  }
  if(process.env.UI_SCREENSHOT)await page.screenshot({path:process.env.UI_SCREENSHOT})
  assert.deepEqual(errors,[])
  console.log('추출기/번역 원본 이름 표시, 긴 이름 줄바꿈, 선택 ID 보존, 실제 SRT 다운로드 통과')
} finally { await browser?.close();await server.close() }
