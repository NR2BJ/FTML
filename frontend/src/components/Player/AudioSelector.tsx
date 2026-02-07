import { useState, useRef, useEffect } from 'react'
import { Volume2 } from 'lucide-react'
import { usePlayerStore } from '@/stores/playerStore'

function formatChannels(channels: number): string {
  switch (channels) {
    case 1: return 'Mono'
    case 2: return 'Stereo'
    case 6: return '5.1'
    case 8: return '7.1'
    default: return `${channels}ch`
  }
}

function formatLanguage(lang?: string): string {
  if (!lang) return ''
  const langMap: Record<string, string> = {
    eng: 'English',
    jpn: 'Japanese',
    kor: 'Korean',
    chi: 'Chinese',
    zho: 'Chinese',
    spa: 'Spanish',
    fre: 'French',
    fra: 'French',
    ger: 'German',
    deu: 'German',
    ita: 'Italian',
    por: 'Portuguese',
    rus: 'Russian',
    und: '',
  }
  return langMap[lang.toLowerCase()] || lang.toUpperCase()
}

export default function AudioSelector() {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const {
    mediaInfo,
    audioTrack,
    setAudioTrack,
  } = usePlayerStore()

  // Close menu on outside click
  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const audioStreams = mediaInfo?.audio_streams
  if (!audioStreams || audioStreams.length <= 1) return null

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="text-sm text-gray-300 hover:text-white transition-colors px-1"
        title="Audio Track"
      >
        <Volume2 className="w-5 h-5" />
      </button>

      {open && (
        <div className="absolute bottom-8 right-0 bg-gray-900/95 border border-gray-700 rounded-lg py-1 min-w-[200px] z-50">
          {audioStreams.map((stream) => {
            const lang = formatLanguage(stream.language)
            const channels = formatChannels(stream.channels)
            const codec = stream.codec_name.toUpperCase()
            const label = stream.title || lang || `Track ${stream.stream_index + 1}`

            return (
              <button
                key={stream.stream_index}
                onClick={() => {
                  setAudioTrack(stream.stream_index)
                  setOpen(false)
                }}
                className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-700 transition-colors ${
                  audioTrack === stream.stream_index ? 'text-primary-400' : 'text-gray-300'
                }`}
              >
                <span>{label}</span>
                <span className="text-xs text-gray-500 ml-2">
                  {codec} {channels}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
