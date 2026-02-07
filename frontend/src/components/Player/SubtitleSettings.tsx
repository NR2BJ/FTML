import { useSubtitleSettings } from '@/stores/subtitleSettingsStore'

interface SubtitleSettingsProps {
  onClose: () => void
}

const colorOptions = [
  { label: 'White', value: '#FFFFFF' },
  { label: 'Yellow', value: '#FFFF00' },
  { label: 'Green', value: '#00FF00' },
  { label: 'Cyan', value: '#00FFFF' },
]

const fontOptions = [
  { label: 'Sans-serif', value: 'sans-serif' },
  { label: 'Serif', value: 'serif' },
  { label: 'Monospace', value: 'monospace' },
]

export default function SubtitleSettings({ onClose }: SubtitleSettingsProps) {
  const {
    syncOffset,
    fontSize,
    fontFamily,
    textColor,
    bgOpacity,
    setSyncOffset,
    setFontSize,
    setFontFamily,
    setTextColor,
    setBgOpacity,
    resetDefaults,
  } = useSubtitleSettings()

  return (
    <div
      className="absolute bottom-12 right-0 bg-gray-900/95 border border-gray-700 rounded-lg p-4 min-w-[240px] z-50"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-white">Subtitle Settings</span>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white text-sm"
        >
          &times;
        </button>
      </div>

      {/* Sync Offset */}
      <div className="mb-3">
        <label className="text-xs text-gray-400 block mb-1">Sync Offset</label>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSyncOffset(Math.round((syncOffset - 0.25) * 100) / 100)}
            className="text-gray-300 hover:text-white bg-gray-700 hover:bg-gray-600 rounded px-2 py-0.5 text-sm"
          >
            -0.25s
          </button>
          <span className="text-sm text-white tabular-nums min-w-[48px] text-center">
            {syncOffset > 0 ? '+' : ''}{syncOffset.toFixed(2)}s
          </span>
          <button
            onClick={() => setSyncOffset(Math.round((syncOffset + 0.25) * 100) / 100)}
            className="text-gray-300 hover:text-white bg-gray-700 hover:bg-gray-600 rounded px-2 py-0.5 text-sm"
          >
            +0.25s
          </button>
        </div>
      </div>

      {/* Font Size */}
      <div className="mb-3">
        <label className="text-xs text-gray-400 block mb-1">Font Size: {fontSize}%</label>
        <input
          type="range"
          min="50"
          max="200"
          step="10"
          value={fontSize}
          onChange={(e) => setFontSize(parseInt(e.target.value))}
          onMouseDown={(e) => e.stopPropagation()}
          className="w-full h-2 accent-primary-500 cursor-pointer appearance-none bg-gray-600 rounded-full"
        />
      </div>

      {/* Font Family */}
      <div className="mb-3">
        <label className="text-xs text-gray-400 block mb-1">Font</label>
        <select
          value={fontFamily}
          onChange={(e) => setFontFamily(e.target.value)}
          className="w-full bg-gray-700 text-white text-sm rounded px-2 py-1 border-none outline-none"
        >
          {fontOptions.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
      </div>

      {/* Text Color */}
      <div className="mb-3">
        <label className="text-xs text-gray-400 block mb-1">Text Color</label>
        <div className="flex gap-2">
          {colorOptions.map((c) => (
            <button
              key={c.value}
              onClick={() => setTextColor(c.value)}
              className={`w-6 h-6 rounded-full border-2 ${
                textColor === c.value ? 'border-primary-500' : 'border-gray-600'
              }`}
              style={{ backgroundColor: c.value }}
              title={c.label}
            />
          ))}
        </div>
      </div>

      {/* Background Opacity */}
      <div className="mb-3">
        <label className="text-xs text-gray-400 block mb-1">Background: {Math.round(bgOpacity * 100)}%</label>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={bgOpacity}
          onChange={(e) => setBgOpacity(parseFloat(e.target.value))}
          onMouseDown={(e) => e.stopPropagation()}
          className="w-full h-2 accent-primary-500 cursor-pointer appearance-none bg-gray-600 rounded-full"
        />
      </div>

      {/* Reset */}
      <button
        onClick={resetDefaults}
        className="text-xs text-gray-400 hover:text-white transition-colors"
      >
        Reset to defaults
      </button>
    </div>
  )
}
