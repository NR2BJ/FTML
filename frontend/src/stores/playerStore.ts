import { create } from 'zustand'
import { MediaInfo } from '@/api/files'
import { SubtitleEntry } from '@/api/subtitle'
import { QualityOption } from '@/api/stream'

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
}))
