// 실제 영상 조각을 브라우저에 넣은 뒤부터만 사용한다. 서버 준비/다운로드는 제외한다.
export class PlaybackStartupWatch {
  private previousTime: number | null = null
  private waitingMs = 0

  check(now: number, readyState: number, visible: boolean): 'waiting' | 'ready' | 'stalled' {
    if (readyState >= 2) return 'ready'
    const elapsed = this.previousTime === null ? 0 : Math.max(0, now - this.previousTime)
    this.previousTime = now

    // 숨겨진 탭이나 컴퓨터 절전 동안 지난 시간을 디코더 실패로 세지 않는다.
    if (!visible || elapsed > 2000) {
      this.waitingMs = 0
      return 'waiting'
    }
    this.waitingMs += elapsed
    return this.waitingMs >= 8000 ? 'stalled' : 'waiting'
  }
}
