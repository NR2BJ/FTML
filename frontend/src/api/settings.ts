import client from './client'

export interface SettingItem {
  key: string
  label: string
  group: string
  placeholder: string
  secret: boolean
  value: string
  has_value: boolean
}

export const getSettings = () =>
  client.get<SettingItem[]>('/settings')

export const updateSettings = (settings: Record<string, string>) =>
  client.put('/settings', settings)
