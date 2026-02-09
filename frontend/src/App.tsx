import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import Login from '@/pages/Login'
import Browse from '@/pages/Browse'
import Watch from '@/pages/Watch'
import Settings from '@/pages/Settings'
import WatchHistory from '@/pages/WatchHistory'
import Account from '@/pages/Account'
import UserManagement from '@/pages/admin/UserManagement'
import Registrations from '@/pages/admin/Registrations'
import Sessions from '@/pages/admin/Sessions'
import Dashboard from '@/pages/admin/Dashboard'
import Layout from '@/components/layout/Layout'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuthStore()

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-dark-950">
        <div className="text-gray-400">Loading...</div>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuthStore()
  if (user?.role !== 'admin') {
    return <Navigate to="/" replace />
  }
  return <>{children}</>
}

export default function App() {
  const { checkAuth } = useAuthStore()

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Browse />} />
          <Route path="browse/*" element={<Browse />} />
          <Route path="watch/*" element={<Watch />} />
          <Route path="history" element={<WatchHistory />} />
          <Route path="account" element={<Account />} />
          <Route path="settings" element={<AdminRoute><Settings /></AdminRoute>} />
          <Route path="admin/users" element={<AdminRoute><UserManagement /></AdminRoute>} />
          <Route path="admin/registrations" element={<AdminRoute><Registrations /></AdminRoute>} />
          <Route path="admin/sessions" element={<AdminRoute><Sessions /></AdminRoute>} />
          <Route path="admin/dashboard" element={<AdminRoute><Dashboard /></AdminRoute>} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
