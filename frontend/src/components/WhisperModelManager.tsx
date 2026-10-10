import { useEffect, useState } from 'react'
import { getGPUInfo, type GPUInfo } from '@/api/whisperModels'

export default function WhisperModelManager() {
  const [gpu, setGPU] = useState<GPUInfo | null>(null)
  useEffect(() => {
    let cancelled = false
    getGPUInfo().then(({ data }) => { if (!cancelled) setGPU(data) }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  return (
    <div className="rounded-lg border border-dark-700 bg-dark-900 p-4 space-y-2 text-sm">
      <p className="font-medium text-white">Whisper large-v3 INT8 · 기본 모델 고정</p>
      <p className="text-gray-400">음성 인식은 로컬 서버에서만 실행합니다. OpenAI API 키는 필요하지 않습니다.</p>
      <p className="text-gray-400">Qwen3-ASR 1.7B / 0.6B 비교는 영상의 자막 작업 창에서 선택하세요. 첫 사용 시 모델을 내려받고 변환합니다.</p>
      <p className="text-gray-500">모델 다운로드와 교체는 작업 시작 시 자동 처리됩니다. 설정 변경으로 진행 중인 작업의 모델을 바꾸지 않습니다.</p>
      {gpu?.device && <p className="text-gray-400">감지된 GPU: {gpu.device}{gpu.vram_total > 0 ? ` · 총 VRAM ${(gpu.vram_total / 1024 ** 3).toFixed(1)} GiB` : ''}</p>}
    </div>
  )
}
