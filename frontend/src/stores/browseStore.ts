import { create } from 'zustand'

export interface ColumnDef {
  id: string
  label: string
  width: number
  visible: boolean
}

export const DEFAULT_COLUMNS: ColumnDef[] = [
  { id: 'name', label: 'Name', width: 300, visible: true },
  { id: 'size', label: 'Size', width: 100, visible: true },
  { id: 'type', label: 'Type', width: 80, visible: true },
  { id: 'duration', label: 'Duration', width: 100, visible: false },
  { id: 'resolution', label: 'Resolution', width: 110, visible: false },
  { id: 'videoCodec', label: 'Video Codec', width: 110, visible: false },
  { id: 'bitrate', label: 'Bitrate', width: 100, visible: false },
  { id: 'audioCodec', label: 'Audio Codec', width: 110, visible: false },
  { id: 'frameRate', label: 'Frame Rate', width: 100, visible: false },
]

type ViewMode = 'icons' | 'details'

interface BrowseState {
  viewMode: ViewMode
  iconSize: number
  columns: ColumnDef[]
  setViewMode: (mode: ViewMode) => void
  setIconSize: (size: number) => void
  toggleColumn: (id: string) => void
  resizeColumn: (id: string, width: number) => void
  reorderColumns: (fromIdx: number, toIdx: number) => void
}

function loadColumns(): ColumnDef[] {
  try {
    const stored = localStorage.getItem('ftml-columns')
    if (stored) {
      const parsed = JSON.parse(stored) as ColumnDef[]
      // Merge with defaults (in case new columns were added)
      const storedMap = new Map(parsed.map((c) => [c.id, c]))
      return DEFAULT_COLUMNS.map((def) => {
        const stored = storedMap.get(def.id)
        return stored ? { ...def, ...stored } : def
      })
    }
  } catch {}
  return DEFAULT_COLUMNS.map((c) => ({ ...c }))
}

function saveColumns(columns: ColumnDef[]) {
  localStorage.setItem('ftml-columns', JSON.stringify(columns))
}

export const useBrowseStore = create<BrowseState>((set) => ({
  viewMode: (localStorage.getItem('ftml-view-mode') as ViewMode) || 'icons',
  iconSize: parseInt(localStorage.getItem('ftml-icon-size') || '180', 10),
  columns: loadColumns(),

  setViewMode: (mode) => {
    localStorage.setItem('ftml-view-mode', mode)
    set({ viewMode: mode })
  },

  setIconSize: (size) => {
    localStorage.setItem('ftml-icon-size', String(size))
    set({ iconSize: size })
  },

  toggleColumn: (id) =>
    set((state) => {
      // Don't allow hiding the name column
      if (id === 'name') return state
      const columns = state.columns.map((c) =>
        c.id === id ? { ...c, visible: !c.visible } : c
      )
      saveColumns(columns)
      return { columns }
    }),

  resizeColumn: (id, width) =>
    set((state) => {
      const columns = state.columns.map((c) =>
        c.id === id ? { ...c, width: Math.max(50, width) } : c
      )
      saveColumns(columns)
      return { columns }
    }),

  reorderColumns: (fromIdx, toIdx) =>
    set((state) => {
      const columns = [...state.columns]
      const [removed] = columns.splice(fromIdx, 1)
      columns.splice(toIdx, 0, removed)
      saveColumns(columns)
      return { columns }
    }),
}))
