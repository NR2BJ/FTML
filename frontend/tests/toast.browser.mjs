// 실행: node tests/toast.browser.mjs (Playwright/Chromium 별도 필요)
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const html = `<!doctype html><html><head></head><body>
<div style="position:fixed;inset:0;background:linear-gradient(135deg,#fff,#38bdf8,#000)"></div>
<div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import ToastContainer from '/src/components/Toast.tsx';
import {useToastStore} from '/src/stores/toastStore.ts';
import '/src/index.css';
window.toastStore = useToastStore;
createRoot(document.getElementById('root')).render(React.createElement(ToastContainer));
</script></body></html>`
const server = await createServer({
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'toast-contrast-fixture',
    configureServer(server) {
      server.middlewares.use('/__toast_test.html', async (_req, res, next) => {
        try {
          const page = await server.transformIndexHtml('/__toast_test.html', html)
          res.setHeader('Content-Type', 'text/html')
          res.end(page)
        } catch (error) { next(error) }
      })
    },
  }],
})

function luminance(rgb) {
  return rgb.slice(0, 3).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1000, height: 650 } })
  page.on('pageerror', error => console.error(error.message))
  await page.goto(`${server.resolvedUrls.local[0]}__toast_test.html`)
  await page.waitForFunction(() => !!window.toastStore)
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => {
      document.documentElement.classList.toggle('dark', theme === 'dark')
      window.toastStore.setState({ toasts: [] })
      for (const type of ['success', 'error', 'info', 'warning']) {
        window.toastStore.getState().addToast({ type, message: `${type}: A-B loop cleared / 구간 반복 해제`, duration: 60000 })
      }
    }, theme)
    await page.locator('[role="status"], [role="alert"]').first().waitFor()
    await page.waitForTimeout(350)
    const results = await page.locator('[role="status"], [role="alert"]').evaluateAll(items => items.map(item => {
      const rgb = value => value.match(/[\d.]+/g).map(Number)
      return {
        background: rgb(getComputedStyle(item).backgroundColor),
        text: rgb(getComputedStyle(item.querySelector('span')).color),
        close: rgb(getComputedStyle(item.querySelector('button')).color),
        icon: rgb(getComputedStyle(item.querySelector('svg')).color),
      }
    }))
    assert.equal(results.length, 4)
    for (const result of results) {
      assert.equal(result.background[3] ?? 1, 1, '영상이 비치지 않는 불투명 배경이어야 한다')
      assert.ok(contrast(result.text, result.background) >= 4.5, '본문 대비')
      assert.ok(contrast(result.close, result.background) >= 3, '닫기 버튼 대비')
      assert.ok(contrast(result.icon, result.background) >= 3, '종류 아이콘 대비')
    }
    if (process.env.TOAST_SCREENSHOT_DIR) {
      await mkdir(process.env.TOAST_SCREENSHOT_DIR, { recursive: true })
      await page.screenshot({ path: `${process.env.TOAST_SCREENSHOT_DIR}/toast-${theme}.png` })
    }
    await page.getByRole('button', { name: '알림 닫기' }).first().click()
    assert.equal(await page.locator('[role="status"], [role="alert"]').count(), 3)
    console.log(`${theme}: 알림 4종의 배경/본문/아이콘/닫기 대비와 닫기 동작 통과`)
  }
  await page.evaluate(() => {
    window.toastStore.setState({ toasts: [] })
    window.toastStore.getState().addToast({ type: 'info', message: '자동 닫힘 확인', duration: 150 })
  })
  await page.waitForFunction(() => window.toastStore.getState().toasts.length === 0)
  assert.equal(await page.locator('[role="status"], [role="alert"]').count(), 0)
  console.log('자동 닫힘 통과')
} finally {
  await browser?.close()
  await server.close()
}
