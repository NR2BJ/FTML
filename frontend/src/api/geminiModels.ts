import client from './client'

export interface GeminiModel {
  id: string
  display_name: string
  description: string
}

export const listGeminiModels = () =>
  client.get<GeminiModel[]>('/gemini/models')
