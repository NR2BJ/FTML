import { create } from 'zustand'

interface PlayerState {
  currentFile: string | null
  isPlaying: boolean
  volume: number
  muted: boolean
  currentTime: number
  duration: number
  playbackRate: number
  setCurrentFile: (path: string | null) => void
  setPlaying: (playing: boolean) => void
  setVolume: (volume: number) => void
  setMuted: (muted: boolean) => void
  setCurrentTime: (time: number) => void
  setDuration: (duration: number) => void
  setPlaybackRate: (rate: number) => void
}

export const usePlayerStore = create<PlayerState>((set) => ({
  currentFile: null,
  isPlaying: false,
  volume: 1,
  muted: false,
  currentTime: 0,
  duration: 0,
  playbackRate: 1,
  setCurrentFile: (path) => set({ currentFile: path }),
  setPlaying: (playing) => set({ isPlaying: playing }),
  setVolume: (volume) => set({ volume }),
  setMuted: (muted) => set({ muted }),
  setCurrentTime: (time) => set({ currentTime: time }),
  setDuration: (duration) => set({ duration }),
  setPlaybackRate: (rate) => set({ playbackRate: rate }),
}))
