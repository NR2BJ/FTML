declare module 'libass-wasm' {
  export default class SubtitlesOctopus {
    constructor(options: { canvas: HTMLCanvasElement; subContent: string; workerUrl: string;
      fonts?: string[]; fallbackFont?: string; targetFps?: number; libassMemoryLimit?: number; libassGlyphLimit?: number; onReady?: () => void; onError?: () => void })
    setCurrentTime(time: number): void
    resize(width: number, height: number): void
    dispose(): void
  }
}
