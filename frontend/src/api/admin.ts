import client from './client'

export interface AdminUser {
  id: number
  username: string
  role: string
  created_at: string
  updated_at: string
}

export interface CreateUserRequest {
  username: string
  password: string
  role: string
}

export interface UpdateUserRequest {
  username?: string
  role?: string
  password?: string
}

export interface Registration {
  id: number
  username: string
  status: string
  created_at: string
  reviewed_at?: string
  reviewed_by?: number
}

export interface WatchHistoryEntry {
  file_path: string
  position: number
  duration: number
  updated_at: string
}

// User management
export const listUsers = () =>
  client.get<AdminUser[]>('/admin/users')

export const createUser = (data: CreateUserRequest) =>
  client.post<{ id: number; username: string; role: string }>('/admin/users', data)

export const updateUser = (id: number, data: UpdateUserRequest) =>
  client.put(`/admin/users/${id}`, data)

export const deleteUser = (id: number) =>
  client.delete(`/admin/users/${id}`)

export const getUserHistory = (id: number) =>
  client.get<WatchHistoryEntry[]>(`/admin/users/${id}/history`)

// Registrations
export const listRegistrations = (status?: string) =>
  client.get<Registration[]>('/admin/registrations', { params: { status } })

export const getPendingRegistrationCount = () =>
  client.get<{ count: number }>('/admin/registrations/count')

export const approveRegistration = (id: number) =>
  client.post(`/admin/registrations/${id}/approve`)

export const rejectRegistration = (id: number) =>
  client.post(`/admin/registrations/${id}/reject`)
