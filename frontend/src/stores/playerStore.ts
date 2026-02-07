import { create } from 'zustand'
import { MediaInfo } from '@/api/files'
import { SubtitleEntry } from '@/api/subtitle'
import { QualityOption } from '@/api/stream'
import { BrowserCodecSupport } from '@/utils/codec'

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
  setSubtitleVisible: (v: boolean) => void
  setQuality: (q: string) => void
  setQualityPresets: (presets: QualityOption[]) => void
  setAudioTrack: (idx: number) => void
  setNegotiatedCodec: (codec: string, encoder: string, hwaccel: string) => void
  setBrowserCodecs: (caps: BrowserCodecSupport) => void
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
  subtitleVisible: true,
  quality: localStorage.getItem('ftml-quality') || '720p',
  qualityPresets: [],
  audioTrack: 0,
  negotiatedCodec: null,
  negotiatedEncoder: null,
  hwaccel: null,
  browserCodecs: null,
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
}))
