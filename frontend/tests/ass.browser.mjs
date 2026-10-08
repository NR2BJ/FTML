// 실행: PLAYWRIGHT_MODULE=... FONT_SAMPLE=... node tests/ass.browser.mjs
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer } from 'vite'
const { chromium, firefox } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
if (!process.env.FONT_SAMPLE) throw Error('시험용 TTF/OTF/TTC 글꼴 경로를 FONT_SAMPLE로 지정하세요')
const font = await readFile(process.env.FONT_SAMPLE)
const dir = await mkdtemp(join(tmpdir(), 'ftml-ass-test-'))
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=640x360:r=24:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(dir, 'video.mp4')])
const video = await readFile(join(dir, 'video.mp4'))
let ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,32,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:01:41.00,0:01:42.00,Default,,0,0,0,,{\\an7\\pos(40,30)}Positioned text
`
const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React,{useRef} from 'react';import{createRoot}from'react-dom/client';
import SubtitleDisplay from '/src/components/Player/SubtitleDisplay.tsx';
import{usePlayerStore}from'/src/stores/playerStore.ts';import{useSubtitleSettings}from'/src/stores/subtitleSettingsStore.ts';
import'/src/index.css';
window.playerStore=usePlayerStore;window.settings=useSubtitleSettings;window.originTime=100;window.changing=false;
usePlayerStore.setState({currentTime:0,activeSubtitle:'external:test.ass',secondarySubtitle:null,subtitleVisible:true,subtitles:[{id:'external:test.ass',format:'ass'}]});
function App(){const ref=useRef(null);return React.createElement('div',{style:{position:'relative',width:640,height:480}},React.createElement('video',{ref,src:'/fixture.mp4',muted:true,style:{width:'100%',height:'100%',objectFit:'contain'}}),React.createElement(SubtitleDisplay,{videoRef:ref,path:'test.mkv',getTime:()=>window.changing?null:(ref.current?.currentTime||0)+window.originTime}));}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`
const server = await createServer({ server:{host:'127.0.0.1',port:0}, plugins:[{name:'ass-fixture',configureServer(server){
  server.middlewares.use(async(req,res,next)=>{
    if (req.url === '/__ass_test.html') {res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/__ass_test.html',html))}
    else if (req.url === '/fixture.mp4') {
      res.setHeader('Content-Type','video/mp4');res.setHeader('Accept-Ranges','bytes')
      const range=req.headers.range?.match(/bytes=(\d+)-(\d*)/)
      if(range){const start=Number(range[1]),end=range[2]?Number(range[2]):video.length-1;res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${video.length}`);res.end(video.subarray(start,end+1))}
      else res.end(video)
    }
    else next()
  })
}}]})
let browser
try {
  await server.listen()
  browser = await (process.env.TEST_BROWSER === 'firefox' ? firefox : chromium).launch({headless:true})
  const page = await browser.newPage()
  const errors=[]
  page.on('pageerror',error=>{errors.push(error.message);console.error(error.message)})
  page.on('console',msg=>console.log(msg.type(),msg.text()))
  await page.route('**/ass-renderer/**',async route=>{
    const response=await route.fetch()
    await route.fulfill({response,headers:{...response.headers(),'content-security-policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self';"}})
  })
  await page.route('**/api/subtitle/**',async route=>{
    const url=new URL(route.request().url())
    if(url.pathname.includes('/fonts/')) return route.fulfill({json:[]})
    if(url.pathname.includes('/font/')) return route.fulfill({body:font,contentType:'font/ttf'})
    return route.fulfill({body:url.searchParams.get('mode')==='native'?ass:'WEBVTT\n\n00:01:41.000 --> 00:01:42.000\nPlain text\n',contentType:'text/plain'})
  })
  await page.goto(`${server.resolvedUrls.local[0]}__ass_test.html`)
  await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2)
  await page.evaluate(()=>document.querySelector('video').currentTime=1.2)
  await page.waitForFunction(()=>Math.abs(document.querySelector('video').currentTime-1.2)<0.01)
  await page.waitForFunction(()=>{
    const c=document.querySelector('canvas');if(!c)return false
    const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data
    return data.some((v,i)=>i%4===3&&v>0)
  },null,{timeout:45000}).catch(async error=>{
    console.error(await page.evaluate(()=>({time:document.querySelector('video').currentTime,body:document.body.innerHTML,canvas:document.querySelector('canvas')?.outerHTML})))
    throw error
  })
  const box=await page.locator('canvas').boundingBox()
  assert.ok(Math.abs(box.height-360)<2 && Math.abs(box.y-60)<2,JSON.stringify(box))
  const bounds=await page.evaluate(()=>{
    const c=document.querySelector('canvas'),data=c.getContext('2d').getImageData(0,0,c.width,c.height).data
    let minY=c.height,maxY=0
    for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++)if(data[(y*c.width+x)*4+3]){minY=Math.min(minY,y);maxY=Math.max(maxY,y)}
    return{minY,maxY,height:c.height}
  })
  assert.ok(bounds.maxY<bounds.height/2,'위치 지정 자막이 하단으로 이동됨')
  await page.evaluate(()=>document.querySelector('video').currentTime=2.2)
  await page.waitForFunction(()=>{const c=document.querySelector('canvas');return !c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v)})
  await page.evaluate(()=>{document.querySelector('video').currentTime=1.2;window.settings.getState().setPlainText(true)})
  await page.getByText('Plain text',{exact:true}).waitFor()
  assert.equal(await page.locator('canvas').count(),0)
  await page.evaluate(()=>window.changing=true)
  await page.getByText('Plain text',{exact:true}).waitFor({state:'hidden'})
  await page.evaluate(()=>{window.changing=false;window.settings.getState().setSyncOffset(2)})
  await page.waitForTimeout(200)
  assert.equal(await page.getByText('Plain text',{exact:true}).count(),0)
  assert.deepEqual(errors,[])
  console.log('ASS 실제 WASM 표시, 위치/검은 여백, HLS 시간 기준, 종료, 일반 표시 전환, 소스 교체 및 동기화 보정 통과')
  const goodASS=ass
  ass='invalid subtitle'
  await page.evaluate(()=>{window.settings.getState().resetDefaults();window.playerStore.getState().setSubtitles([{id:'external:test.ass',format:'ass'}])})
  await page.getByText('Plain text',{exact:true}).waitFor()
  assert.equal(await page.locator('canvas').count(),0)
  console.log('손상된 ASS의 일반 표시 자동 전환 통과')
  ass=goodASS
  if (process.env.FTML_ASS_SAMPLE) {
    ass = await readFile(process.env.FTML_ASS_SAMPLE, 'utf8')
    await page.evaluate(()=>{window.settings.getState().resetDefaults();window.originTime=35;document.querySelector('video').currentTime=1.2;window.playerStore.getState().setSubtitles([{id:'external:test.ass',format:'ass'}])})
    await page.waitForFunction(()=>{const c=document.querySelector('canvas');return c && c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v)},{},{timeout:45000})
    if (process.env.ASS_SCREENSHOT) await page.screenshot({path:process.env.ASS_SCREENSHOT})
    console.log('첨부 ASS의 36.2초 원형 표시 확인')
  }
} finally {
  await browser?.close();await server.close();await rm(dir,{recursive:true,force:true})
}
