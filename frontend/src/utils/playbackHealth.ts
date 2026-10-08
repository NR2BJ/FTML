export interface HealthSample {
  now: number
  time: number
  rate: number
  frames: number
  dropped: number
  buffer: number
  paused: boolean
  seeking: boolean
  visible: boolean
  server?: { state: string; output_time: number; throttled: boolean }
}

// 순간적인 버퍼 대기나 백그라운드 절전을 코덱 문제로 오인하지 않는다.
export class PlaybackHealthWatch {
  private previous: HealthSample | null = null
  private decodeDelay = 0
  private serverDelay = 0

  reset() { this.previous = null; this.decodeDelay = 0; this.serverDelay = 0 }

  check(s: HealthSample): 'browser' | 'slow' | null {
    const p = this.previous
    this.previous = s
    if (!p || s.paused || s.seeking || !s.visible || s.rate !== p.rate || s.now-p.now > 4000 || s.now <= p.now || s.time < p.time || s.time-p.time > (s.now-p.now)/1000*s.rate+2) {
      this.decodeDelay = 0; this.serverDelay = 0
      return null
    }
    const elapsed = s.now-p.now
    const frames = s.frames-p.frames
    const dropped = s.dropped-p.dropped
    const slowClock = s.time-p.time < elapsed/1000*s.rate*0.7
    const badDecode = s.buffer >= 5 && (slowClock || (frames >= 12 && dropped/frames > 0.2))
    this.decodeDelay = badDecode ? this.decodeDelay+elapsed : 0
    // 서버에 다음 구간이 준비돼 있다면 전송 대기를 인코더 성능 문제로 단정하지 않는다.
    const starved = s.buffer < 1 && s.server?.state === 'running' && !s.server.throttled && s.server.output_time < s.time+5
    this.serverDelay = starved ? this.serverDelay+elapsed : 0
    if (this.decodeDelay >= 9000) { this.reset(); return 'browser' }
    if (this.serverDelay >= 18000) { this.reset(); return 'slow' }
    return null
  }
}
