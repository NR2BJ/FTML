import client from './client'

export interface WatchHistoryEntry {
  file_path: string
  position: number
  duration: number
  updated_at: string
}

export const saveWatchPosition = (path: string, position: number, duration: number) =>
  client.put(`/user/history/${path}`, { position, duration })

export const getWatchPosition = (path: string) =>
  client.get<{ position: number }>(`/user/history/${path}`)

export const listWatchHistory = () =>
  client.get<WatchHistoryEntry[]>('/user/history')

export const deleteWatchHistory = (path: string) =>
  client.delete(`/user/history/${path}`)

export const changePassword = (currentPassword: string, newPassword: string) =>
  client.put('/user/password', { current_password: currentPassword, new_password: newPassword })
