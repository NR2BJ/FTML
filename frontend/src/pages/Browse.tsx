import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getTree, type FileEntry } from '@/api/files'
import { Folder, FileVideo, File, ArrowLeft } from 'lucide-react'
import { isVideoFile, formatBytes } from '@/utils/format'

export default function Browse() {
  const params = useParams()
  const path = params['*'] || ''
  const navigate = useNavigate()
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    getTree(path)
      .then(({ data }) => setEntries(data.entries || []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false))
  }, [path])

  const handleClick = (entry: FileEntry) => {
    if (entry.is_dir) {
      navigate(`/browse/${entry.path}`)
    } else if (isVideoFile(entry.name)) {
      navigate(`/watch/${entry.path}`)
    }
  }

  const goUp = () => {
    const parts = path.split('/')
    parts.pop()
    navigate(parts.length > 0 ? `/browse/${parts.join('/')}` : '/')
  }

  if (loading) {
    return <div className="text-gray-400">Loading...</div>
  }

  return (
    <div>
      {path && (
        <div className="flex items-center gap-2 mb-4">
          <button onClick={goUp} className="text-gray-400 hover:text-white transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h2 className="text-lg text-gray-300 font-medium truncate">
            {path.split('/').pop()}
          </h2>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {entries.map((entry) => {
          const Icon = entry.is_dir ? Folder : isVideoFile(entry.name) ? FileVideo : File
          const iconColor = entry.is_dir ? 'text-yellow-400' : isVideoFile(entry.name) ? 'text-blue-400' : 'text-gray-500'

          return (
            <button
              key={entry.path}
              onClick={() => handleClick(entry)}
              className="bg-dark-900 border border-dark-700 rounded-lg p-4 hover:bg-dark-800 hover:border-dark-600 transition-colors text-left group"
            >
              <div className="flex items-center gap-3">
                <Icon className={`w-8 h-8 ${iconColor} shrink-0`} />
                <div className="min-w-0">
                  <p className="text-sm text-gray-200 truncate group-hover:text-white">
                    {entry.name}
                  </p>
                  {!entry.is_dir && entry.size && (
                    <p className="text-xs text-gray-500 mt-0.5">
                      {formatBytes(entry.size)}
                    </p>
                  )}
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {entries.length === 0 && (
        <div className="text-center text-gray-500 mt-16">
          <Folder className="w-16 h-16 mx-auto mb-4 opacity-30" />
          <p>This folder is empty</p>
        </div>
      )}
    </div>
  )
}
