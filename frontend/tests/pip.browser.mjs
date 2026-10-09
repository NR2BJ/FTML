// PLAYWRIGHT_MODULE=... FONT_SAMPLE=... TEST_BROWSER=firefox node tests/pip.browser.mjs
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer } from 'vite'
const { chromium, firefox } = await import(
  process.env.PLAYWRIGHT_MODULE || 'playwright'
)
const font = await readFile(
  process.env.FONT_SAMPLE || '/System/Library/Fonts/Hiragino Sans GB.ttc',
)
const dir = await mkdtemp(join(tmpdir(), 'ftml-pip-'))
execFileSync('ffmpeg', [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=black:s=640x360:r=24:d=5',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
  join(dir, 'video.mp4'),
])
const video = await readFile(join(dir, 'video.mp4'))
const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,32,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:01:41.00,0:01:42.00,Default,,0,0,0,,{\\an7\\pos(40,30)}First
Dialogue: 0,0:01:42.00,0:01:43.00,Default,,0,0,0,,{\\an1\\pos(40,320)}Second
`
const vtt =
  'WEBVTT\n\n00:01:41.000 --> 00:01:42.000\nFirst\n\n00:01:42.000 --> 00:01:43.000\nSecond\n'
const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React,{useRef,useState}from'react';import{createRoot}from'react-dom/client';import{createPortal}from'react-dom';
import SubtitleDisplay from'/src/components/Player/SubtitleDisplay.tsx';import Controls from'/src/components/Player/Controls.tsx';import{usePictureInPicture}from'/src/components/Player/usePictureInPicture.ts';
import{usePlayerStore}from'/src/stores/playerStore.ts';import{useSubtitleSettings}from'/src/stores/subtitleSettingsStore.ts';import'/src/index.css';
window.settings=useSubtitleSettings;window.store=usePlayerStore;window.originTime=100;window.changing=false;
usePlayerStore.setState({currentFile:'test.mkv',duration:105,activeSubtitle:'external:test.ass',subtitles:[{id:'external:test.ass',format:'ass',label:'효과 자막'},{id:'external:plain.vtt',format:'vtt',label:'일반 자막'}],subtitleVisible:true});
function Player({path}){const ref=useRef(null);const pip=usePictureInPicture(path,ref);const target=pip.pipWindow||window;window.pipState=pip;window.videoRef=ref;
return React.createElement('div',{ref:pip.dockRef,style:{height:480,width:800}},createPortal(React.createElement('div',{className:'player-container relative bg-black h-full group'},
React.createElement('video',{ref,src:'/fixture.mp4',muted:true,style:{width:'100%',height:'100%',objectFit:'contain'},onTimeUpdate:()=>usePlayerStore.setState({currentTime:ref.current.currentTime+window.originTime})}),
React.createElement(SubtitleDisplay,{videoRef:ref,path:'test.mkv',renderWindow:target,getTime:()=>window.changing?null:ref.current.currentTime+window.originTime}),
React.createElement(Controls,{videoRef:ref,filePath:'test.mkv',onTogglePlay:()=>{ref.current.paused?ref.current.play():ref.current.pause()},onSeek:t=>ref.current.currentTime=t-window.originTime,onToggleFullscreen:()=>{},onTogglePiP:pip.toggle,pipSupported:true,renderWindow:target})),pip.host));}
function App(){const[shown,setShown]=useState(true);const[path,setPath]=useState('test.mkv');window.changePath=setPath;window.removePlayer=()=>setShown(false);window.showPlayer=()=>setShown(true);return shown?React.createElement(Player,{path}):null;}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));
</script></body></html>`
const server = await createServer({
  cacheDir: join(dir, 'vite-cache'),
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  plugins: [
    {
      name: 'pip-fixture',
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (req.url === '/__pip.html') {
            res.setHeader('Content-Type', 'text/html')
            res.end(await s.transformIndexHtml('/__pip.html', html))
          } else if (req.url === '/fixture.mp4') {
            res.setHeader('Content-Type', 'video/mp4')
            res.setHeader('Accept-Ranges', 'bytes')
            const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/)
            if (range) {
              const start = Number(range[1]),
                end = range[2] ? Number(range[2]) : video.length - 1
              res.statusCode = 206
              res.setHeader(
                'Content-Range',
                `bytes ${start}-${end}/${video.length}`,
              )
              res.end(video.subarray(start, end + 1))
            } else res.end(video)
          } else if (req.url?.startsWith('/api/subtitle/')) {
            const url = new URL(req.url, 'http://localhost')
            if (url.pathname.includes('/fonts/')) {
              res.setHeader('Content-Type', 'application/json')
              res.end('[]')
            } else if (url.pathname.includes('/font/')) {
              res.setHeader('Content-Type', 'font/ttf')
              res.end(font)
            } else {
              res.setHeader('Content-Type', 'text/plain')
              res.end(url.searchParams.get('mode') === 'native' ? ass : vtt)
            }
          } else next()
        })
      },
    },
  ],
})
let browser
try {
  await server.listen()
  browser = await (
    process.env.TEST_BROWSER === 'firefox' ? firefox : chromium
  ).launch({ headless: process.env.HEADED !== '1' })
  const page = await browser.newPage()
  console.log(
    '브라우저',
    browser.browserType().name(),
    browser.version(),
    await page.evaluate(() => navigator.userAgent),
  )
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const diagnostics = (p) => {
    p.on('console', (m) => {
      if (
        ['warning', 'error'].includes(m.type()) &&
        !m.text().startsWith('Canvas2D:')
      )
        console.error(m.text())
    })
    p.on('requestfailed', (r) => {
      if (!r.failure()?.errorText.includes('ABORTED'))
        console.error('요청 실패', r.url(), r.failure())
    })
  }
  diagnostics(page)
  page.context().on('page', (p) => {
    diagnostics(p)
    p.on('pageerror', (e) => errors.push(e.message))
  })
  await page.goto(`${server.resolvedUrls.local[0]}__pip.html`)
  await page.waitForFunction(() => window.videoRef.current?.readyState >= 2)
  await page.evaluate(() => {
    window.originalVideo = window.videoRef.current
    window.videoRef.current.currentTime = 1.2
  })
  await page
    .waitForFunction(() =>
      Array.from(window.videoRef.current.textTracks).some(
        (t) => t.activeCues?.[0]?.text === 'First',
      ),
    )
    .catch(async (error) => {
      console.error(
        await page.evaluate(() => ({
          time: window.videoRef.current.currentTime,
          ready: window.videoRef.current.readyState,
          tracks: Array.from(window.videoRef.current.textTracks).map((t) => ({
            mode: t.mode,
            cues: Array.from(t.cues || []).map((c) => [
              c.startTime,
              c.endTime,
              c.text,
            ]),
            active: Array.from(t.activeCues || []).map((c) => c.text),
          })),
        })),
      )
      throw error
    })
  await page.waitForFunction(
    () => {
      const c = document.querySelector('canvas')
      return c
        ?.getContext('2d')
        .getImageData(0, 0, c.width, c.height)
        .data.some((v, i) => i % 4 === 3 && v)
    },
    {},
    { timeout: 45000 },
  )
  assert.equal(
    await page.evaluate(() => window.videoRef.current.textTracks.length),
    1,
    'StrictMode에서도 트랙 누적 없음',
  )
  await page.evaluate(() => window.settings.getState().setSyncOffset(1))
  await page.waitForFunction(
    () =>
      window.videoRef.current.textTracks[0]?.activeCues?.[0]?.text === 'Second',
  )
  await page.evaluate(() => {
    window.changing = true
    window.videoRef.current.dispatchEvent(new Event('emptied'))
  })
  await page.waitForFunction(
    () => !window.videoRef.current.textTracks[0]?.activeCues?.length,
  )
  await page.evaluate(() => {
    window.changing = false
    window.originTime = 101
    window.settings.getState().setSyncOffset(0)
    window.videoRef.current.dispatchEvent(new Event('loadedmetadata'))
  })
  await page.waitForFunction(
    () =>
      window.videoRef.current.textTracks[0]?.activeCues?.[0]?.text === 'Second',
  )
  await page.evaluate(() => {
    window.originTime = 100
    window.store.getState().setSubtitleVisible(false)
  })
  await page.waitForFunction(
    () => window.videoRef.current.textTracks[0]?.mode === 'disabled',
  )
  await page.evaluate(() => window.store.getState().setSubtitleVisible(true))
  await page.waitForFunction(
    () =>
      window.videoRef.current.textTracks[0]?.activeCues?.[0]?.text === 'First',
  )
  console.log(
    '표준 자막 트랙: HLS 원점 변경·시간 보정·소스 교체·자막 끄기/켜기·중복 방지 통과',
  )

  if (await page.evaluate(() => !!window.documentPictureInPicture)) {
    await page.evaluate(() => window.videoRef.current.play())
    await page.locator('.player-container').hover()
    await page
      .getByTitle('자막 포함 PiP / 돌아오기 (P)', { exact: true })
      .click()
    await page.waitForFunction(() =>
      window.pipState.pipWindow?.document.querySelector('video'),
    )
    assert.equal(
      await page.evaluate(
        () =>
          window.pipState.pipWindow.document.querySelector('video') ===
          window.originalVideo,
      ),
      true,
    )
    assert.equal(
      await page.locator('video').count(),
      0,
      '영상과 자막을 원래 탭에 중복 생성하지 않음',
    )
    assert.equal(
      await page.evaluate(() => window.videoRef.current.paused),
      false,
      'PiP 진입 후 재생 유지',
    )
    await page.evaluate(() => {
      window.videoRef.current.pause()
      window.videoRef.current.currentTime = 1.2
    })
    await page
      .waitForFunction(
        () => {
          const c = window.pipState.pipWindow.document.querySelector('canvas')
          if (!c) return false
          return c
            .getContext('2d')
            .getImageData(0, 0, c.width, c.height)
            .data.some((v, i) => i % 4 === 3 && v)
        },
        null,
        { polling: 100, timeout: 45000 },
      )
      .catch(async (error) => {
        console.error(
          await page.evaluate(() => {
            const p = window.pipState.pipWindow,
              c = p?.document.querySelector('canvas'),
              v = window.videoRef.current
            return {
              time: v.currentTime,
              paused: v.paused,
              mainHidden: document.hidden,
              pipHidden: p?.document.hidden,
              renderer: typeof p?.SubtitlesOctopus,
              canvas: c && {
                width: c.width,
                height: c.height,
                style: c.style.cssText,
              },
              text: p?.document.body.textContent,
              errors: window.errors,
            }
          }),
        )
        console.error(errors)
        throw error
      })
    assert.equal(
      await page.evaluate(
        () => typeof window.pipState.pipWindow.SubtitlesOctopus,
      ),
      'function',
    )
    const pipPage = page
      .context()
      .pages()
      .find((p) => p !== page)
    if (pipPage) {
      await pipPage.setViewportSize({ width: 480, height: 270 })
      await pipPage.locator('.player-container').hover()
      await pipPage.waitForFunction(
        () =>
          Number(
            getComputedStyle(document.querySelector('.player-controls'))
              .opacity,
          ) > 0.9,
      )
      if (process.env.PIP_SCREENSHOT)
        await pipPage.screenshot({ path: process.env.PIP_SCREENSHOT })
    }
    // 원래 창의 화면 갱신이 완전히 중단돼도 PiP의 ASS는 새 시각에 그려야 한다.
    await page.evaluate(() => {
      window.oldRAF = window.requestAnimationFrame
      window.requestAnimationFrame = () => 0
      window.videoRef.current.currentTime = 2.2
    })
    await page.waitForFunction(
      () => {
        const c = window.pipState.pipWindow.document.querySelector('canvas'),
          d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        return d.some(
          (v, i) =>
            i % 4 === 3 && v && Math.floor(i / 4 / c.width) > c.height / 2,
        )
      },
      null,
      { polling: 100, timeout: 8000 },
    )
    await page.evaluate(() => (window.videoRef.current.currentTime = 3.2))
    await page.waitForFunction(
      () => {
        const c = window.pipState.pipWindow.document.querySelector('canvas')
        return !c
          .getContext('2d')
          .getImageData(0, 0, c.width, c.height)
          .data.some((v, i) => i % 4 === 3 && v)
      },
      null,
      { polling: 100 },
    )
    await page.evaluate(() => {
      window.requestAnimationFrame = window.oldRAF
      window.videoRef.current.currentTime = 1.2
      window.settings.getState().setPlainText(true)
    })
    await page.waitForFunction(() =>
      window.pipState.pipWindow.document
        .querySelector('.subtitle-text-overlay')
        ?.textContent.includes('First'),
    )
    // 포털의 React 위임 이벤트와 PiP 문서의 메뉴 바깥 클릭을 함께 검사한다.
    if (pipPage) await pipPage.getByTitle('Subtitles', { exact: true }).click()
    else
      await page.evaluate(() =>
        window.pipState.pipWindow.document
          .querySelector('button[title="Subtitles"]')
          .click(),
      )
    await page.waitForFunction(() =>
      window.pipState.pipWindow.document.body.textContent.includes('일반 자막'),
    )
    if (pipPage) {
      const item = pipPage.getByRole('button', { name: /^일반 자막/ })
      const box = await item.boundingBox()
      assert.ok(
        box &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= 480 &&
          box.y + box.height <= 270,
        '작은 PiP 창에서도 자막 메뉴가 화면 안에 표시됨',
      )
      await item.click()
    } else
      await page.evaluate(() => {
        const doc = window.pipState.pipWindow.document
        const button = Array.from(doc.querySelectorAll('button')).find((b) =>
          b.textContent.includes('일반 자막'),
        )
        button.click()
      })
    await page.waitForFunction(
      () => window.store.getState().activeSubtitle === 'external:plain.vtt',
    )
    await page.evaluate(() => window.videoRef.current.play())
    const savedTime = await page.evaluate(
      () => window.videoRef.current.currentTime,
    )
    await page.evaluate(() => window.pipState.pipWindow.close())
    await page.waitForFunction(
      () =>
        !window.pipState.pipWindow &&
        document.querySelector('video') === window.originalVideo,
    )
    assert.equal(
      await page.evaluate(() => window.videoRef.current.paused),
      false,
      'PiP 종료 후 재생 유지',
    )
    assert.ok(
      Math.abs(
        (await page.evaluate(() => window.videoRef.current.currentTime)) -
          savedTime,
      ) < 0.5,
    )
    await page.locator('.player-container').hover()
    await page
      .getByTitle('자막 포함 PiP / 돌아오기 (P)', { exact: true })
      .click()
    await page.waitForFunction(() => !!window.pipState.pipWindow)
    await page.evaluate(() => {
      window.lastPip = window.pipState.pipWindow
      window.removePlayer()
    })
    await page.waitForFunction(() => window.lastPip.closed)
    assert.equal(await page.locator('video').count(), 0)
    await page.evaluate(() => window.showPlayer())
    await page.waitForFunction(() => !!window.videoRef.current)
    await page.evaluate(() => {
      const api = window.documentPictureInPicture
      window.requestPiP = api.requestWindow.bind(api)
      api.requestWindow = async () => {
        throw new Error('시험용 거부')
      }
    })
    await page.locator('.player-container').hover()
    await page
      .getByTitle('자막 포함 PiP / 돌아오기 (P)', { exact: true })
      .click()
    assert.equal(
      await page.evaluate(() => window.pipState.pipWindow),
      null,
      '열기 실패는 기존 화면 유지',
    )
    await page.evaluate(() => {
      window.documentPictureInPicture.requestWindow = async (options) => {
        const pip = await window.requestPiP(options)
        window.delayedPip = pip
        return new Promise((resolve) => {
          window.releasePiP = () => resolve(pip)
        })
      }
    })
    await page
      .getByTitle('자막 포함 PiP / 돌아오기 (P)', { exact: true })
      .click()
    await page.waitForFunction(() => !!window.releasePiP)
    await page.evaluate(() => window.changePath('next.mkv'))
    await page.waitForFunction(() => !window.pipState.pipWindow)
    await page.evaluate(() => window.releasePiP())
    await page.waitForFunction(() => window.delayedPip.closed)
    assert.equal(
      await page.locator('video').count(),
      1,
      '이전 영상의 늦은 창은 열지 않음',
    )
    await page.evaluate(() => {
      window.documentPictureInPicture.requestWindow = window.requestPiP
      window.removePlayer()
    })
    console.log(
      '실제 Document PiP: 재생/영상 요소 유지·ASS 위치/만료·원래 창 rAF 정지·일반 자막·React 메뉴·닫기 복귀·제거 시 창 종료·열기 실패·늦은 창 응답 차단 통과',
    )
  } else {
    console.log(
      '이 브라우저에는 Document PiP 없음: 표준 TextTrack 전달 확인. 브라우저 자체 PiP 창의 실제 자막 표시는 별도 확인 필요',
    )
    await page.evaluate(() => window.removePlayer())
  }
  assert.deepEqual(errors, [])
} finally {
  await browser?.close()
  await server.close()
  await rm(dir, { recursive: true, force: true })
}
