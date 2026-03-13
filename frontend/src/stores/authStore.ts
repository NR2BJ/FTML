import { create } from 'zustand'
import { login as loginApi, getMe, type User } from '@/api/auth'
import { clearStoredAuthToken, getStoredAuthToken, persistAuthToken, syncAuthTokenCookie } from '@/utils/authToken'

interface AuthState {
  user: User | null
  token: string | null
  isLoading: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  checkAuth: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: getStoredAuthToken(),
  isLoading: true,

  login: async (username, password) => {
    const { data } = await loginApi({ username, password })
    persistAuthToken(data.token)
    set({ token: data.token, user: data.user })
  },

  logout: () => {
    clearStoredAuthToken()
    set({ user: null, token: null })
  },

  checkAuth: async () => {
    const token = getStoredAuthToken()
    if (!token) {
      set({ isLoading: false })
      return
    }
    syncAuthTokenCookie()
    try {
      const { data } = await getMe()
      set({ user: data, token, isLoading: false })
    } catch {
      clearStoredAuthToken()
      set({ user: null, token: null, isLoading: false })
    }
  },
}))
