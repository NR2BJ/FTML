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
  success: 'text-green-400 border-green-400/50',
  error: 'text-red-400 border-red-400/50',
  info: 'text-blue-400 border-blue-400/50',
  warning: 'text-amber-400 border-amber-400/50',
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
      role={toast.type === 'error' ? 'alert' : 'status'}
      className={`flex items-center gap-2.5 px-4 py-3 rounded-lg border bg-slate-900 shadow-lg min-w-[280px] max-w-[400px] animate-slide-in ${colors[toast.type]}`}
    >
      <Icon className="w-4 h-4 shrink-0" />
      {/* 영상 위의 알림은 밝은 테마의 전역 gray 글자색 재정의를 적용하지 않는다. */}
      <span className="text-sm text-slate-100 flex-1">{toast.message}</span>
      <button
        type="button"
        aria-label="알림 닫기"
        onClick={() => removeToast(toast.id)}
        className="text-slate-300 hover:text-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-100 rounded shrink-0"
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
