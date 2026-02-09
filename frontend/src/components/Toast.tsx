import { useEffect } from 'react'
import { CheckCircle, XCircle, Info, AlertTriangle, X } from 'lucide-react'
import { useToastStore, type Toast } from '@/stores/toastStore'

const icons = {
  success: CheckCircle,
  error: XCircle,
  info: Info,
  warning: AlertTriangle,
}

const colors = {
  success: 'text-green-400 bg-green-500/10 border-green-500/30',
  error: 'text-red-400 bg-red-500/10 border-red-500/30',
  info: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
  warning: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
}

function ToastItem({ toast }: { toast: Toast }) {
  const { removeToast } = useToastStore()
  const Icon = icons[toast.type]

  useEffect(() => {
    const timer = setTimeout(() => removeToast(toast.id), toast.duration)
    return () => clearTimeout(timer)
  }, [toast.id, toast.duration, removeToast])

  return (
    <div
      className={`flex items-center gap-2.5 px-4 py-3 rounded-lg border shadow-lg backdrop-blur-sm min-w-[280px] max-w-[400px] animate-slide-in ${colors[toast.type]}`}
    >
      <Icon className="w-4 h-4 shrink-0" />
      <span className="text-sm text-gray-200 flex-1">{toast.message}</span>
      <button
        onClick={() => removeToast(toast.id)}
        className="text-gray-500 hover:text-gray-300 shrink-0"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

export default function ToastContainer() {
  const { toasts } = useToastStore()

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
