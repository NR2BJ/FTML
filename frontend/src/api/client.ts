import axios from 'axios'
import { clearStoredAuthToken, getStoredAuthToken } from '@/utils/authToken'

const client = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
})

client.interceptors.request.use((config) => {
  const token = getStoredAuthToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      clearStoredAuthToken()
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

export default client
