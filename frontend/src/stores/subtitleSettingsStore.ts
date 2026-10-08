import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface SubtitleSettingsState {
  plainText: boolean
  setPlainText: (v: boolean) => void
  syncOffset: number
  fontSize: number
  fontFamily: string
  textColor: string
  bgOpacity: number
  setSyncOffset: (v: number) => void
  setFontSize: (v: number) => void
  setFontFamily: (v: string) => void
  setTextColor: (v: string) => void
  setBgOpacity: (v: number) => void
  resetDefaults: () => void
}

const defaults = {
  plainText: false,
  syncOffset: 0,
  fontSize: 100,
  fontFamily: 'sans-serif',
  textColor: '#FFFFFF',
  bgOpacity: 0.75,
}

export const useSubtitleSettings = create<SubtitleSettingsState>()(
  persist(
    (set) => ({
      ...defaults,
      setPlainText: (v) => set({ plainText: v }),
      setSyncOffset: (v) => set({ syncOffset: v }),
      setFontSize: (v) => set({ fontSize: v }),
      setFontFamily: (v) => set({ fontFamily: v }),
      setTextColor: (v) => set({ textColor: v }),
      setBgOpacity: (v) => set({ bgOpacity: v }),
      resetDefaults: () => set(defaults),
    }),
    { name: 'ftml-subtitle-settings' }
  )
)
