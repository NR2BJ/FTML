import { create } from 'zustand'
import { MediaInfo, ChapterInfo } from '@/api/files'
import { SubtitleEntry } from '@/api/subtitle'
import { QualityOption } from '@/api/stream'
import { BrowserCodecSupport } from '@/utils/codec'

interface ABLoop {
  a: number | null
  b: number | null
}

interface PlayerState {
  currentFile: string | null
  isPlaying: boolean
  volume: number
  muted: boolean
  currentTime: number
  duration: number
  playbackRate: number
  // Resume playback
  resumePosition: number | null
  hasResumed: boolean
  // Media info
  mediaInfo: MediaInfo | null
  // Stats overlay
  showStats: boolean
  // Subtitles
  subtitles: SubtitleEntry[]
  activeSubtitle: string | null
  secondarySubtitle: string | null
  subtitleVisible: boolean
  // Quality
  quality: string
  qualityPresets: QualityOption[]
  // Audio track
  audioTrack: number  // audio-only stream index (0-based)
  // Codec (Phase 3)
  negotiatedCodec: string | null    // 'h264' | 'hevc' | 'av1' | 'vp9'
  negotiatedEncoder: string | null  // 'h264_vaapi', 'libx264', etc.
  hwaccel: string | null            // 'vaapi' or 'none'
  browserCodecs: BrowserCodecSupport | null
  // A-B Loop
  abLoop: ABLoop
  // Chapters
  chapters: ChapterInfo[]
  setCurrentFile: (path: string | null) => void
  setPlaying: (playing: boolean) => void
  setVolume: (volume: number) => void
  setMuted: (muted: boolean) => void
  setCurrentTime: (time: number) => void
  setDuration: (duration: number) => void
  setPlaybackRate: (rate: number) => void
  setResumePosition: (pos: number | null) => void
  setHasResumed: (v: boolean) => void
  setMediaInfo: (info: MediaInfo | null) => void
  setShowStats: (v: boolean) => void
  setSubtitles: (subs: SubtitleEntry[]) => void
  setActiveSubtitle: (id: string | null) => void
  setSecondarySubtitle: (id: string | null) => void
  setSubtitleVisible: (v: boolean) => void
  setQuality: (q: string) => void
  setQualityPresets: (presets: QualityOption[]) => void
  setAudioTrack: (idx: number) => void
  setNegotiatedCodec: (codec: string, encoder: string, hwaccel: string) => void
  setBrowserCodecs: (caps: BrowserCodecSupport) => void
  setChapters: (chapters: ChapterInfo[]) => void
  toggleABLoop: (currentTime: number) => void
  clearABLoop: () => void
}

export const usePlayerStore = create<PlayerState>((set) => ({
  currentFile: null,
  isPlaying: false,
  volume: 1,
  muted: false,
  currentTime: 0,
  duration: 0,
  playbackRate: 1,
  resumePosition: null,
  hasResumed: false,
  mediaInfo: null,
  showStats: false,
  subtitles: [],
  activeSubtitle: null,
  secondarySubtitle: null,
  subtitleVisible: true,
  quality: localStorage.getItem('ftml-quality') || '720p',
  qualityPresets: [],
  audioTrack: 0,
  negotiatedCodec: null,
  negotiatedEncoder: null,
  hwaccel: null,
  browserCodecs: null,
  abLoop: { a: null, b: null },
  chapters: [],
  setCurrentFile: (path) => set({ currentFile: path }),
  setPlaying: (playing) => set({ isPlaying: playing }),
  setVolume: (volume) => set({ volume }),
  setMuted: (muted) => set({ muted }),
  setCurrentTime: (time) => set({ currentTime: time }),
  setDuration: (duration) => set({ duration }),
  setPlaybackRate: (rate) => set({ playbackRate: rate }),
  setResumePosition: (pos) => set({ resumePosition: pos }),
  setHasResumed: (v) => set({ hasResumed: v }),
  setMediaInfo: (info) => set({ mediaInfo: info }),
  setShowStats: (v) => set({ showStats: v }),
  setSubtitles: (subs) => set({ subtitles: subs }),
  setActiveSubtitle: (id) => set({ activeSubtitle: id }),
  setSecondarySubtitle: (id) => set({ secondarySubtitle: id }),
  setSubtitleVisible: (v) => set({ subtitleVisible: v }),
  setQuality: (q) => {
    localStorage.setItem('ftml-quality', q)
    set({ quality: q })
  },
  setQualityPresets: (presets) => set({ qualityPresets: presets }),
  setAudioTrack: (idx) => set({ audioTrack: idx }),
  setNegotiatedCodec: (codec, encoder, hwaccel) => set({
    negotiatedCodec: codec,
    negotiatedEncoder: encoder,
    hwaccel,
  }),
  setBrowserCodecs: (caps) => set({ browserCodecs: caps }),
  setChapters: (chapters) => set({ chapters }),
  toggleABLoop: (currentTime) => set((state) => {
    const { a, b } = state.abLoop
    if (a === null) {
      // Set point A
      return { abLoop: { a: currentTime, b: null } }
    } else if (b === null) {
      // Set point B (ensure B > A)
      return { abLoop: { a, b: currentTime > a ? currentTime : a } }
    } else {
      // Clear
      return { abLoop: { a: null, b: null } }
    }
  }),
  clearABLoop: () => set({ abLoop: { a: null, b: null } }),
}))
