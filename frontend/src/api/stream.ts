const getToken = () => localStorage.getItem('token') || ''

export const getHLSUrl = (path: string) =>
  `/api/stream/hls/${path}?token=${getToken()}`

export const getDirectUrl = (path: string) =>
  `/api/stream/direct/${path}?token=${getToken()}`
