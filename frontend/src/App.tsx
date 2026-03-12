import { Suspense, lazy, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { initTheme } from '@/stores/themeStore'

const Login = lazy(() => import('@/pages/Login'))
const Browse = lazy(() => import('@/pages/Browse'))
const Watch = lazy(() => import('@/pages/Watch'))
const Settings = lazy(() => import('@/pages/Settings'))
const WatchHistory = lazy(() => import('@/pages/WatchHistory'))
const Account = lazy(() => import('@/pages/Account'))
const UserManagement = lazy(() => import('@/pages/admin/UserManagement'))
const Registrations = lazy(() => import('@/pages/admin/Registrations'))
const Sessions = lazy(() => import('@/pages/admin/Sessions'))
const Dashboard = lazy(() => import('@/pages/admin/Dashboard'))
const RateLimits = lazy(() => import('@/pages/admin/RateLimits'))
const Trash = lazy(() => import('@/pages/admin/Trash'))
const DeleteRequests = lazy(() => import('@/pages/admin/DeleteRequests'))
const Jobs = lazy(() => import('@/pages/Jobs'))
const Layout = lazy(() => import('@/components/layout/Layout'))

// Initialize theme before render
initTheme()

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

function RouteFallback() {
  return (
    <div className="flex items-center justify-center h-screen bg-dark-950">
      <div className="text-gray-400">Loading...</div>
    </div>
  )
}

function renderLazy(element: React.ReactNode) {
  return <Suspense fallback={<RouteFallback />}>{element}</Suspense>
}

export default function App() {
  const { checkAuth } = useAuthStore()

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={renderLazy(<Login />)} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              {renderLazy(<Layout />)}
            </ProtectedRoute>
          }
        >
          <Route index element={renderLazy(<Browse />)} />
          <Route path="browse/*" element={renderLazy(<Browse />)} />
          <Route path="watch/*" element={renderLazy(<Watch />)} />
          <Route path="history" element={renderLazy(<WatchHistory />)} />
          <Route path="account" element={renderLazy(<Account />)} />
          <Route path="jobs" element={renderLazy(<Jobs />)} />
          <Route path="settings" element={<AdminRoute>{renderLazy(<Settings />)}</AdminRoute>} />
          <Route path="admin/users" element={<AdminRoute>{renderLazy(<UserManagement />)}</AdminRoute>} />
          <Route path="admin/registrations" element={<AdminRoute>{renderLazy(<Registrations />)}</AdminRoute>} />
          <Route path="admin/sessions" element={<AdminRoute>{renderLazy(<Sessions />)}</AdminRoute>} />
          <Route path="admin/dashboard" element={<AdminRoute>{renderLazy(<Dashboard />)}</AdminRoute>} />
          <Route path="admin/ratelimits" element={<AdminRoute>{renderLazy(<RateLimits />)}</AdminRoute>} />
          <Route path="admin/delete-requests" element={<AdminRoute>{renderLazy(<DeleteRequests />)}</AdminRoute>} />
          <Route path="admin/trash" element={<AdminRoute>{renderLazy(<Trash />)}</AdminRoute>} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
