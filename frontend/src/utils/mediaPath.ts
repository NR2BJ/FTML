export function encodeMediaPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}
