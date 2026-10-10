import { useEffect, useRef, type HTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type MouseEvent } from 'react'
import type { FileEntry } from '@/api/files'
import { isVideoFile } from '@/utils/format'
import { selectBrowseEntry } from '@/utils/browseSelection'

export interface BrowseSelection {
  entryProps: (entry: FileEntry, ordered: FileEntry[]) => HTMLAttributes<HTMLDivElement>
  checkboxProps: (entry: FileEntry, ordered: FileEntry[]) => InputHTMLAttributes<HTMLInputElement>
  replaceSelection: (paths: Set<string>) => void
}

export function useBrowseSelection(
  directory: string, selected: Set<string>, onChange: (paths: Set<string>) => void,
  onOpen: (entry: FileEntry) => void, onSubtitles: (entries: FileEntry[]) => void,
): BrowseSelection {
  // 행 번호 대신 경로를 기억해 정렬 후에도 같은 항목에서 범위를 시작한다.
  const anchor = useRef<string | null>(null)
  useEffect(() => { anchor.current = null }, [directory])
  const replaceSelection = (paths: Set<string>) => {
    anchor.current = null
    onChange(paths)
  }
  const select = (event: MouseEvent | KeyboardEvent, entry: FileEntry, ordered: FileEntry[], toggle = false) => {
    const next = selectBrowseEntry(ordered.map(e => e.path), selected, anchor.current, entry.path, {
      range: event.shiftKey, additive: event.ctrlKey || event.metaKey, toggle,
    })
    anchor.current = next.anchor
    onChange(next.paths)
  }
  const openSubtitles = (entry: FileEntry, ordered: FileEntry[]) => {
    const targets = selected.has(entry.path) ? ordered.filter(e => selected.has(e.path)) : [entry]
    if (!selected.has(entry.path)) {
      anchor.current = entry.path
      onChange(new Set([entry.path]))
    }
    if (entry.is_dir || !isVideoFile(entry.name)) return
    onSubtitles(targets.filter(e => !e.is_dir && isVideoFile(e.name)))
  }
  return {
    replaceSelection,
    entryProps: (entry, ordered) => ({
      role: 'button', tabIndex: 0, 'aria-label': entry.name, 'aria-pressed': selected.has(entry.path),
      onClick: event => select(event, entry, ordered),
      onDoubleClick: event => {
        if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) onOpen(entry)
      },
      onContextMenu: event => { event.preventDefault(); openSubtitles(entry, ordered) },
      onKeyDown: event => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter') { event.preventDefault(); onOpen(entry) }
        else if (event.key === ' ') { event.preventDefault(); select(event, entry, ordered, true) }
        else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          event.preventDefault(); openSubtitles(entry, ordered)
        }
      },
    }),
    checkboxProps: (entry, ordered) => ({
      type: 'checkbox', checked: selected.has(entry.path), 'aria-label': `${entry.name} 선택`,
      onChange: () => {},
      onClick: event => { event.stopPropagation(); select(event, entry, ordered, true) },
      onDoubleClick: event => event.stopPropagation(),
    }),
  }
}
