import assert from 'node:assert/strict'
import { createServer } from 'vite'
const { chromium, firefox } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from'react';import{createRoot}from'react-dom/client';import'/src/index.css';
import{MemoryRouter,Routes,Route,useLocation,useNavigate}from'react-router-dom';
import Browse from'/src/pages/Browse.tsx';import{useAuthStore}from'/src/stores/authStore.ts';
useAuthStore.setState({user:{role:'admin'}});
function Location(){window.navigate=useNavigate();return React.createElement('output',{id:'location'},useLocation().pathname)}
function App(){return React.createElement(MemoryRouter,null,React.createElement(Location),React.createElement(Routes,null,
React.createElement(Route,{path:'/',element:React.createElement(Browse)}),
React.createElement(Route,{path:'/browse/*',element:React.createElement(Browse)}),
React.createElement(Route,{path:'/watch/*',element:React.createElement('p',null,'재생 화면')})))}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));
</script></body></html>`
const server = await createServer({server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'browse-selection',configureServer(s){
  s.middlewares.use('/__browse.html',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__browse.html',html))})
}}]})
const entries = [
  {name:'folder',path:'folder',is_dir:true},
  ...['a.mkv','b.mkv','c.mkv','d.mkv','e.mkv','notes.txt'].map((name,index)=>({name,path:name,is_dir:false,size:index+1})),
]
const addKey = process.platform === 'darwin' ? 'Meta' : 'Control'
let browser
try {
  await server.listen()
  browser = await (process.env.TEST_BROWSER==='firefox'?firefox:chromium).launch({headless:true})
  for (const view of ['icons','details']) {
    const context = await browser.newContext({viewport:{width:1200,height:900}})
    const page = await context.newPage(), errors=[]
    page.setDefaultTimeout(10000)
    page.on('pageerror',error=>errors.push(error.message))
    await page.addInitScript(mode=>localStorage.setItem('ftml-view-mode',mode),view)
    await page.route('**/api/**',route=>{
      const p = new URL(route.request().url()).pathname
      if(!p.startsWith('/api/'))return route.continue()
      if(p==='/api/files/tree/')return route.fulfill({json:{entries}})
      if(p==='/api/files/tree/folder')return route.fulfill({json:{entries:[{name:'inside.mkv',path:'folder/inside.mkv',is_dir:false}]}})
      if(p==='/api/files/batch-info')return route.fulfill({json:[]})
      if(p.startsWith('/api/files/thumbnail/'))return route.fulfill({status:404})
      if(p==='/api/whisper/backends/available')return route.fulfill({json:[]})
      if(p.startsWith('/api/subtitle/reference/'))return route.fulfill({json:{}})
      if(p==='/api/presets'||p==='/api/jobs/active')return route.fulfill({json:[]})
      errors.push(`예상하지 않은 요청: ${p}`)
      return route.fulfill({status:404})
    })
    await page.goto(`${server.resolvedUrls.local[0]}__browse.html`)
    const row = name=>page.getByRole('button',{name,exact:true})
    const checked = name=>page.getByRole('checkbox',{name:`${name} 선택`,exact:true})
    const assertSelected = async names=>{
      const selected = await page.locator('[aria-pressed="true"][aria-label]').evaluateAll(els=>els.map(el=>el.getAttribute('aria-label')).sort())
      assert.deepEqual(selected,[...names].sort())
      for(const entry of entries)assert.equal(await checked(entry.name).isChecked(),names.includes(entry.name))
      assert.equal(await page.locator('#location').innerText(),'/')
    }
    await row('a.mkv').click()
    await assertSelected(['a.mkv'])
    assert.equal(await page.getByRole('button',{name:'자막 패널',exact:true}).count(),0)
    assert.equal(await page.getByRole('dialog').count(),0)
    // Mac의 실제 Ctrl+클릭은 우클릭이므로 Windows 클릭 수정키는 별도로 전달한다.
    await row('c.mkv').dispatchEvent('click',{ctrlKey:true})
    await assertSelected(['a.mkv','c.mkv'])
    await row('c.mkv').dispatchEvent('click',{ctrlKey:true})
    await assertSelected(['a.mkv'])
    await row('b.mkv').click({modifiers:[addKey]})
    await assertSelected(['a.mkv','b.mkv'])
    await row('b.mkv').click({modifiers:[addKey]})
    await assertSelected(['a.mkv'])
    await row('b.mkv').click()
    await row('e.mkv').click({modifiers:['Shift']})
    await assertSelected(['b.mkv','c.mkv','d.mkv','e.mkv'])
    await row('c.mkv').click({modifiers:['Shift']})
    await assertSelected(['b.mkv','c.mkv'])
    await row('e.mkv').click({modifiers:[addKey]})
    await row('d.mkv').click({modifiers:[addKey,'Shift']})
    await assertSelected(['b.mkv','c.mkv','d.mkv','e.mkv'])
    if(process.env.UI_SCREENSHOT)await page.screenshot({path:`${process.env.UI_SCREENSHOT}-${view}.png`,animations:'disabled'})

    await row('c.mkv').click({button:'right'})
    const panel = page.getByRole('dialog',{name:'자막 작업'})
    await panel.waitFor()
    assert.equal(await panel.getByText('영상 4개',{exact:true}).count(),1)
    assert.equal(await page.getByRole('menu').count(),0)
    await page.getByRole('button',{name:'자막 작업 닫기',exact:true}).click()
    await assertSelected(['b.mkv','c.mkv','d.mkv','e.mkv'])
    await row('a.mkv').click({button:'right'})
    await panel.waitFor()
    assert.equal(await panel.getByText('a.mkv',{exact:true}).count(),1)
    await page.getByRole('button',{name:'자막 작업 닫기',exact:true}).click()
    await assertSelected(['a.mkv'])
    await row('notes.txt').click({button:'right'})
    await assertSelected(['notes.txt'])
    assert.equal(await panel.count(),0)
    await row('folder').click({button:'right'})
    await assertSelected(['folder'])
    assert.equal(await panel.count(),0)

    await page.getByRole('button',{name:'선택 해제',exact:true}).click()
    await row('a.mkv').hover()
    await checked('a.mkv').click()
    await row('d.mkv').hover()
    await checked('d.mkv').click({modifiers:['Shift']})
    await assertSelected(['a.mkv','b.mkv','c.mkv','d.mkv'])
    await row('e.mkv').hover()
    await checked('e.mkv').dblclick()
    await assertSelected(['a.mkv','b.mkv','c.mkv','d.mkv'])
    await row('e.mkv').dblclick({modifiers:[addKey]})
    await assertSelected(['a.mkv','b.mkv','c.mkv','d.mkv'])
    await page.getByRole('button',{name:'선택 해제',exact:true}).click()
    await row('d.mkv').click({modifiers:['Shift']})
    await assertSelected(['d.mkv'])

    if(view==='details') {
      await row('b.mkv').click()
      await page.getByText('Name',{exact:true}).click()
      await row('d.mkv').click({modifiers:['Shift']})
      await assertSelected(['b.mkv','c.mkv','d.mkv'])
      await page.getByRole('checkbox',{name:'전체 선택',exact:true}).click()
      await assertSelected(entries.map(e=>e.name))
      await row('c.mkv').click({button:'right'})
      await panel.waitFor()
      assert.equal(await panel.getByText('영상 5개',{exact:true}).count(),1)
      await page.getByRole('button',{name:'자막 작업 닫기',exact:true}).click()
      await page.getByRole('checkbox',{name:'전체 선택',exact:true}).click()
      await assertSelected([])
      await page.getByText('Name',{exact:true}).click({button:'right'})
      await page.getByRole('button',{name:'Duration',exact:true}).waitFor()
      await page.locator('#location').click()
    }

    await row('b.mkv').focus()
    await page.keyboard.press('Space')
    await assertSelected(view==='details'?['b.mkv']:['b.mkv','d.mkv'])
    await page.keyboard.press('Shift+F10')
    await panel.waitFor()
    await page.getByRole('button',{name:'자막 작업 닫기',exact:true}).click()
    await row('b.mkv').click()
    await page.getByTitle(view==='details'?'Icons':'Details',{exact:true}).click()
    await row('d.mkv').click({modifiers:['Shift']})
    await assertSelected(['b.mkv','c.mkv','d.mkv'])
    await row('folder').click()
    await assertSelected(['folder'])
    await row('folder').dblclick()
    await row('inside.mkv').waitFor()
    assert.equal(await page.locator('#location').innerText(),'/browse/folder')
    await row('inside.mkv').click({modifiers:['Shift']})
    assert.equal(await checked('inside.mkv').isChecked(),true)
    assert.equal(await page.locator('[aria-pressed="true"]').count(),1)
    await row('inside.mkv').dblclick()
    await page.getByText('재생 화면',{exact:true}).waitFor()
    assert.equal(await page.locator('#location').innerText(),'/watch/folder/inside.mkv')
    await page.evaluate(()=>window.navigate('/'))
    await row('a.mkv').waitFor()
    await row('a.mkv').focus()
    await page.keyboard.press('Enter')
    await page.getByText('재생 화면',{exact:true}).waitFor()
    assert.equal(await page.locator('#location').innerText(),'/watch/a.mkv')
    assert.deepEqual(errors,[])
    await context.close()
    console.log(`${view}: 단일/추가/범위/체크박스 선택, 우클릭 직접 패널, 더블클릭·키보드 열기, 폴더 이동 통과`)
  }
} finally { await browser?.close(); await server.close() }
