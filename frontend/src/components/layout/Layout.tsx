import { Outlet } from 'react-router-dom'
import Header from './Header'
import Sidebar from './Sidebar'
import ToastContainer from '@/components/Toast'

export default function Layout() {
  return (
    <div className="h-screen flex flex-col bg-dark-950">
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto p-4">
          <Outlet />
        </main>
      </div>
      <ToastContainer />
    </div>
  )
}
