import { useParams } from 'react-router-dom'
import Player from '@/components/Player/Player'

export default function Watch() {
  const params = useParams()
  const path = params['*'] || ''

  if (!path) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        Select a video to play
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="mb-2">
        <h2 className="text-lg font-medium text-gray-200 truncate">
          {path.split('/').pop()}
        </h2>
        <p className="text-sm text-gray-500 truncate">{path}</p>
      </div>
      <div className="flex-1 min-h-0">
        <Player path={path} />
      </div>
    </div>
  )
}
