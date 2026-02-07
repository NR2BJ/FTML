import client from './client'

export const saveWatchPosition = (path: string, position: number, duration: number) =>
  client.put(`/user/history/${path}`, { position, duration })

export const getWatchPosition = (path: string) =>
  client.get<{ position: number }>(`/user/history/${path}`)
