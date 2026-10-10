export function selectBrowseEntry(
  orderedPaths: string[], selected: Set<string>, anchor: string | null, target: string,
  { range = false, additive = false, toggle = false } = {},
): { paths: Set<string>; anchor: string } {
  const end = orderedPaths.indexOf(target)
  const start = anchor === null ? -1 : orderedPaths.indexOf(anchor)
  if (range && start >= 0 && end >= 0) {
    const paths = new Set(additive || toggle ? selected : [])
    for (const path of orderedPaths.slice(Math.min(start, end), Math.max(start, end) + 1)) paths.add(path)
    return { paths, anchor: anchor! }
  }
  const paths = new Set(additive || toggle ? selected : [])
  if ((additive || toggle) && paths.has(target)) paths.delete(target)
  else paths.add(target)
  return { paths, anchor: target }
}
