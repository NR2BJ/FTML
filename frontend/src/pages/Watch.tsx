import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import Player from '@/components/Player/Player'

export default function Watch() {
  const params = useParams()
  const navigate = useNavigate()
  const path = params['*'] || ''

  const handleBack = () => {
    const parts = path.split('/')
    parts.pop() // remove filename
    const parentPath = parts.join('/')
    navigate(parentPath ? `/browse/${parentPath}` : '/')
  }

  if (!path) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        Select a video to play
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="mb-2 flex items-center gap-3">
        <button
          onClick={handleBack}
          className="text-gray-400 hover:text-white transition-colors shrink-0"
          title="Back to file browser"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="min-w-0">
          <h2 className="text-lg font-medium text-gray-200 truncate">
            {path.split('/').pop()}
          </h2>
          <p className="text-sm text-gray-500 truncate">{path}</p>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <Player path={path} />
      </div>
    </div>
  )
}
