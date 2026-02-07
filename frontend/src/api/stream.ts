const getToken = () => localStorage.getItem('token') || ''

export const getHLSUrl = (path: string, quality: string = 'medium') =>
  `/api/stream/hls/${path}?token=${getToken()}&quality=${quality}`

export const getDirectUrl = (path: string) =>
  `/api/stream/direct/${path}?token=${getToken()}`
