const getToken = () => localStorage.getItem('token') || ''

export const getHLSUrl = (path: string, quality: string = 'medium', startTime: number = 0) => {
  let url = `/api/stream/hls/${path}?token=${getToken()}&quality=${quality}`
  if (startTime > 0) {
    url += `&start=${Math.floor(startTime)}`
  }
  return url
}

export const getDirectUrl = (path: string) =>
  `/api/stream/direct/${path}?token=${getToken()}`
