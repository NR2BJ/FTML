// 실행: node tests/subtitles.browser.mjs (Playwright/Chromium 별도 필요)
import assert from 'node:assert/strict'
import { createServer } from 'vite'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

const html = `<!doctype html><html><head></head><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import SubtitleDisplay from '/src/components/Player/SubtitleDisplay.tsx';
import {usePlayerStore} from '/src/stores/playerStore.ts';
import '/src/index.css';
window.playerStore = usePlayerStore;
usePlayerStore.setState({currentTime:1,activeSubtitle:'generated:ko.vtt',secondarySubtitle:'generated:ja.vtt',
  subtitles:[],subtitleVisible:true});
createRoot(document.getElementById('root')).render(React.createElement(SubtitleDisplay,{path:'fixture.mkv',videoRef:{current:null}}));
</script></body></html>`
const server = await createServer({
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'subtitle-reload-fixture', configureServer(server) {
    server.middlewares.use('/__subtitle_test.html', async (_req, res, next) => {
      try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__subtitle_test.html', html)) }
      catch (error) { next(error) }
    })
  } }],
})
const vtt = (a, b) => `WEBVTT\n\n00:00.000 --> 00:02.000\n${a}\n\n00:02.000 --> 00:04.000\n${b}\n`
let primary = 'WEBVTT\n\n00:00.000 --> 99:59:59.000\n교체 전 자막\n'
let secondary = vtt('보조 첫 문장', '보조 둘째 문장')
let requests = 0
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  page.on('pageerror', error => console.error(error.message))
  await page.route('**/api/subtitle/content/**', async route => {
    requests++
    const id = new URL(route.request().url()).searchParams.get('id')
    const body = id === 'generated:ko.vtt' ? primary : secondary
    if (id === 'generated:slow.vtt') await new Promise(resolve => setTimeout(resolve, 300))
    await route.fulfill({ contentType: 'text/vtt', body }).catch(() => {})
  })
  await page.goto(`${server.resolvedUrls.local[0]}__subtitle_test.html`)
  await page.getByText('교체 전 자막', { exact: true }).waitFor()
  primary = vtt('갱신 첫 문장', '갱신 둘째 문장')
  secondary = vtt('새 보조 첫 문장', '새 보조 둘째 문장')
  await page.evaluate(() => window.playerStore.getState().setSubtitles([]))
  await page.getByText('갱신 첫 문장', { exact: true }).waitFor()
  await page.getByText('새 보조 첫 문장', { exact: true }).waitFor()
  await page.evaluate(() => window.playerStore.getState().setCurrentTime(3))
  await page.getByText('갱신 둘째 문장', { exact: true }).waitFor()
  assert.equal(await page.getByText('갱신 첫 문장', { exact: true }).count(), 0)
  await page.evaluate(() => window.playerStore.getState().setCurrentTime(5))
  await page.waitForFunction(() => document.querySelector('#root').textContent === '')
  console.log('같은 ID의 주/보조 자막 갱신, 시간 이동과 만료 통과')

  await page.evaluate(() => window.playerStore.getState().setSubtitleVisible(false))
  await page.waitForTimeout(100)
  const before = requests
  primary = vtt('다시 켠 자막', '새 끝 문장')
  await page.evaluate(() => window.playerStore.getState().setCurrentTime(1))
  await page.waitForTimeout(100)
  assert.equal(requests, before, '숨긴 동안에는 다시 요청하지 않는다')
  await page.evaluate(() => window.playerStore.getState().setSubtitleVisible(true))
  await page.getByText('다시 켠 자막', { exact: true }).waitFor()
  assert.ok(requests > before)
  console.log('끄기/켜기 재조회 통과')

  await page.evaluate(() => window.playerStore.getState().setActiveSubtitle('generated:slow.vtt'))
  await page.waitForTimeout(100)
  await page.evaluate(() => window.playerStore.getState().setActiveSubtitle('generated:ko.vtt'))
  await page.getByText('다시 켠 자막', { exact: true }).waitFor()
  await page.waitForTimeout(400)
  assert.equal(await page.getByText('다시 켠 자막', { exact: true }).count(), 1)
  console.log('늦게 도착한 이전 언어 응답 무시 통과')
} finally {
  await browser?.close()
  await server.close()
}
