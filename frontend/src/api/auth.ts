import client from './client'

export interface LoginRequest {
  username: string
  password: string
}

export interface User {
  id: number
  username: string
  role: string
}

export interface LoginResponse {
  token: string
  user: User
}

export const login = (data: LoginRequest) =>
  client.post<LoginResponse>('/auth/login', data)

export const getMe = () =>
  client.get<User>('/auth/me')
