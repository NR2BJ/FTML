import assert from 'node:assert/strict'
import { createServer } from 'vite'
const { chromium, firefox } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React,{useState}from'react';import{createRoot}from'react-dom/client';import'/src/index.css';
import Menu from'/src/components/Browse/ContextMenu.tsx';import Panel from'/src/components/Subtitles/SubtitleTaskDialog.tsx';
import{useAuthStore}from'/src/stores/authStore.ts';import{useJobStore}from'/src/stores/jobStore.ts';import{usePlayerStore}from'/src/stores/playerStore.ts';
window.auth=useAuthStore;window.jobs=useJobStore;window.player=usePlayerStore;useAuthStore.setState({user:{role:'admin'}});
const entries=[{name:'a.mkv',path:'a.mkv',is_dir:false},{name:'b.mkv',path:'b.mkv',is_dir:false}];
function App(){const[open,setOpen]=useState(false);return open?React.createElement(Panel,{paths:entries.map(e=>e.path),initialMode:'generate',onClose:()=>setOpen(false)}):React.createElement(Menu,{x:10,y:10,selectedEntries:entries,onClose:()=>{},onSubtitles:()=>setOpen(true)});}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));
</script></body></html>`
const server = await createServer({server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'subtitle-panel',configureServer(s){
  s.middlewares.use('/__panel.html',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__panel.html',html))})
}}]})
const generated={id:'generated:whisper_ja.vtt',label:'Whisper 추출 (일본어)',type:'generated',format:'vtt',language:'ja'}
const external={id:'external:original.ass',label:'외부 원본.ass',type:'external',format:'ass',language:'zh'}
const newer={...generated,id:'generated:translated.vtt',label:'Gemini 번역 (한국어)'}
let entries={'a.mkv':[generated,external],'b.mkv':[generated]}, pending=[], deletions=[], requests=[]
let browser
try {
  await server.listen()
  browser=await(process.env.TEST_BROWSER==='firefox'?firefox:chromium).launch({headless:true})
  const page=await browser.newPage({viewport:{width:1100,height:1000}}), errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url()), p=url.pathname
    if(!p.startsWith('/api/'))return route.continue()
    if(p==='/api/whisper/backends/available')return route.fulfill({json:[{value:'backend:1',label:'A380',type:'openvino-genai'}]})
    if(p==='/api/presets'||p==='/api/jobs/active')return route.fulfill({json:[]})
    if(p.startsWith('/api/subtitle/list/'))return route.fulfill({json:entries[p.split('/').at(-1)]})
    if(p.startsWith('/api/subtitle/delete/')) {
      const path=p.split('/').at(-1), id=url.searchParams.get('id')
      deletions.push({path,id});entries[path]=entries[path].filter(s=>s.id!==id)
      return route.fulfill({json:{status:'deleted'}})
    }
    if(p==='/api/subtitle/my-delete-requests')return route.fulfill({json:pending})
    if(p.startsWith('/api/subtitle/delete-request/')) {
      const path=p.split('/').at(-1), data=route.request().postDataJSON()
      requests.push({path,...data});pending.push({video_path:path,subtitle_id:data.subtitle_id,status:'pending'})
      return route.fulfill({json:{status:'pending'}})
    }
    throw Error(p)
  })
  await page.goto(`${server.resolvedUrls.local[0]}__panel.html`)
  assert.equal(await page.getByRole('menuitem').count(),1)
  await page.getByRole('menuitem',{name:'자막 패널',exact:true}).click()
  const tabs=page.getByLabel('작업 종류',{exact:true}).getByRole('button')
  assert.equal(await tabs.last().innerText(),'자막 삭제')
  await page.getByRole('button',{name:'자막 삭제',exact:true}).click()
  await page.getByTitle(external.label,{exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'삭제',exact:true}).count(),1)
  await page.getByRole('button',{name:'삭제',exact:true}).click()
  assert.equal(deletions.length,0)
  await page.getByRole('button',{name:'취소',exact:true}).click()
  assert.equal(deletions.length,0)
  await page.getByRole('button',{name:'삭제',exact:true}).click()
  await page.getByRole('button',{name:'확인',exact:true}).click()
  await page.getByTitle(generated.label,{exact:true}).waitFor({state:'detached'})
  assert.deepEqual(deletions,[{path:'a.mkv',id:generated.id}])
  entries['a.mkv'].push(newer)
  await page.evaluate(()=>window.jobs.setState({jobs:[{id:'new-result',file_path:'a.mkv',status:'completed'}]}))
  await page.getByTitle(newer.label,{exact:true}).waitFor()
  await page.getByLabel('관리할 영상',{exact:true}).selectOption('b.mkv')
  await page.getByTitle(generated.label,{exact:true}).waitFor()
  assert.equal(await page.getByTitle(newer.label,{exact:true}).count(),0)
  await page.evaluate(()=>window.auth.setState({user:{role:'user'}}))
  await page.getByRole('button',{name:'삭제 요청',exact:true}).click()
  await page.getByRole('button',{name:'확인',exact:true}).click()
  await page.getByRole('button',{name:'삭제 요청 중',exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'삭제 요청 중',exact:true}).isDisabled(),true)
  assert.equal(requests[0].path,'b.mkv')
  assert.equal(deletions.length,1)
  await page.evaluate(()=>window.auth.setState({user:{role:'viewer'}}))
  await page.getByTitle(generated.label,{exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'삭제',exact:true}).count(),0)
  assert.equal(await page.getByRole('button',{name:'삭제 요청',exact:true}).count(),0)
  assert.equal(await page.getByLabel('작업 종류',{exact:true}).getByRole('button').count(),1)
  assert.deepEqual(errors,[])
  console.log('단일 자막 메뉴, 오른쪽 삭제 탭, 확인/취소, 완료 결과 즉시 갱신, 영상별 목록, 관리자/사용자/열람 권한 통과')
} finally {await browser?.close();await server.close()}
