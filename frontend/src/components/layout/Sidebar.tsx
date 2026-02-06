import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { getTree, type FileEntry } from '@/api/files'
import { ChevronRight, ChevronDown, Folder, FolderOpen, FileVideo, File } from 'lucide-react'
import { isVideoFile } from '@/utils/format'

function TreeNode({ entry, level = 0 }: { entry: FileEntry; level?: number }) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()

  const isActive = location.pathname.includes(entry.path)

  const handleToggle = async () => {
    if (!entry.is_dir) {
      if (isVideoFile(entry.name)) {
        navigate(`/watch/${entry.path}`)
      }
      return
    }

    if (!expanded && children.length === 0) {
      setLoading(true)
      try {
        const { data } = await getTree(entry.path)
        setChildren(data.entries || [])
      } catch {
        setChildren([])
      }
      setLoading(false)
    }
    setExpanded(!expanded)
  }

  const Icon = entry.is_dir
    ? expanded ? FolderOpen : Folder
    : isVideoFile(entry.name) ? FileVideo : File

  const iconColor = entry.is_dir
    ? 'text-yellow-400'
    : isVideoFile(entry.name) ? 'text-blue-400' : 'text-gray-500'

  return (
    <div>
      <button
        onClick={handleToggle}
        className={`w-full flex items-center gap-1.5 px-2 py-1 text-sm hover:bg-dark-800 rounded transition-colors ${
          isActive ? 'bg-dark-800 text-white' : 'text-gray-300'
        }`}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
      >
        {entry.is_dir ? (
          expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-gray-500 shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-gray-500 shrink-0" />
          )
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <Icon className={`w-4 h-4 shrink-0 ${iconColor}`} />
        <span className="truncate">{entry.name}</span>
      </button>

      {expanded && (
        <div>
          {loading && (
            <div className="text-xs text-gray-500 px-4 py-1" style={{ paddingLeft: `${(level + 1) * 16 + 8}px` }}>
              Loading...
            </div>
          )}
          {children.map((child) => (
            <TreeNode key={child.path} entry={child} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function Sidebar() {
  const [entries, setEntries] = useState<FileEntry[]>([])

  useEffect(() => {
    getTree()
      .then(({ data }) => setEntries(data.entries || []))
      .catch(() => setEntries([]))
  }, [])

  return (
    <aside className="w-64 bg-dark-900 border-r border-dark-700 overflow-y-auto shrink-0">
      <div className="p-3">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Files
        </h2>
        {entries.map((entry) => (
          <TreeNode key={entry.path} entry={entry} />
        ))}
        {entries.length === 0 && (
          <p className="text-sm text-gray-500 px-2">No files found</p>
        )}
      </div>
    </aside>
  )
}
