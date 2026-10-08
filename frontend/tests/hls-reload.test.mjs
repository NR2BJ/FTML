import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// 설치된 실제 배포 묶음으로 검사한다. 첫 목록의 갱신 주기를 두 번 더하면 실패한다.
test('조각 하나로 시작한 HLS 목록은 한 주기 뒤에 갱신한다', async () => {
  let now = 10000
  let nextID = 0
  const timers = new Map()
  const scheduled = (fn, delay = 0, repeat = false) => {
    const id = ++nextID
    timers.set(id, { fn, at: now + delay, delay, repeat })
    return id
  }
  const sandbox = {
    console, URL, performance: { now: () => now },
    setTimeout: (fn, delay) => scheduled(fn, delay),
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => scheduled(fn, delay, true),
    clearInterval: id => timers.delete(id),
    navigator: { userAgent: 'test' },
    location: { href: 'https://example.test/' },
  }
  sandbox.self = sandbox
  sandbox.window = sandbox
  const context = vm.createContext(sandbox)
  vm.runInContext(await readFile(new URL('../node_modules/hls.js/dist/hls.js', import.meta.url), 'utf8'), context)
  const requests = []
  class PlaylistLoader {
    constructor() {
      this.stats = { aborted: false, loaded: 0, total: 0, retry: 0, chunkCount: 0, bwEstimate: 0,
        loading: { start: now, first: now, end: now },
        parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } }
    }
    load(context, _config, callbacks) {
      requests.push({ time: now, type: context.type })
      this.context = context
      const data = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6,\nseg_00000.ts\n'
        + (requests.length > 1 ? '#EXTINF:6,\nseg_00001.ts\n#EXT-X-ENDLIST\n' : '')
      scheduled(() => callbacks.onSuccess({ url: context.url, data }, this.stats, context, null), 1)
    }
    abort() {}
    destroy() {}
  }
  const hls = new sandbox.Hls({ loader: PlaylistLoader, enableWorker: false })
  try {
    hls.loadSource('https://example.test/playlist.m3u8')
    const until = now + 6100
    for (let steps = 0; steps < 1000; steps++) {
      const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!entry || entry[1].at > until) break
      const [id, timer] = entry
      timers.delete(id)
      now = timer.at
      if (timer.repeat) timers.set(id, { ...timer, at: now + timer.delay })
      timer.fn()
    }
    assert.equal(requests.length, 2, '6초 분량만 받은 상태에서 다음 요청을 12초 후까지 미루지 않는다')
    assert.equal(requests[0].type, 'manifest')
    assert.equal(requests[1].type, 'level')
    assert.ok(requests[1].time - requests[0].time <= 6001)
  } finally {
    hls.destroy()
  }
})
