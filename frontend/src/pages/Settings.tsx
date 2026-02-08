import { useState, useEffect } from 'react'
import { Settings as SettingsIcon, Save, Check, Loader2, Eye, EyeOff } from 'lucide-react'
import { getSettings, updateSettings, type SettingItem } from '@/api/settings'
import WhisperModelManager from '@/components/WhisperModelManager'
import WhisperBackendManager from '@/components/WhisperBackendManager'

export default function Settings() {
  const [settings, setSettings] = useState<SettingItem[]>([])
  const [values, setValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set())

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      const { data } = await getSettings()
      setSettings(data)
      // Initialize form values with current (masked) values
      const vals: Record<string, string> = {}
      for (const s of data) {
        vals[s.key] = s.value
      }
      setValues(vals)
    } catch {
      setError('Failed to load settings')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      // Only send values that were changed (not still masked)
      const changed: Record<string, string> = {}
      for (const s of settings) {
        const newVal = values[s.key] || ''
        // Skip if value still matches the original masked value
        if (newVal !== s.value) {
          changed[s.key] = newVal
        }
      }

      if (Object.keys(changed).length > 0) {
        await updateSettings(changed)
      }
      setSaved(true)
      // Reload to get fresh masked values
      await loadSettings()
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setError('Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  const toggleVisibility = (key: string) => {
    setVisibleKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Group settings
  const groups = settings.reduce<Record<string, SettingItem[]>>((acc, s) => {
    ;(acc[s.group] ??= []).push(s)
    return acc
  }, {})

  const groupLabels: Record<string, string> = {
    whisper: 'Whisper STT (Speech-to-Text)',
    translation: 'Translation API Keys',
    subtitle: 'Subtitle & Translation',
  }

  const settingHelp: Record<string, string> = {
    whisper_model: 'Active model is managed via the model manager below. This field shows the current setting stored in the database.',
    whisper_language: 'Default language for transcription. Use "auto" for automatic detection, or ISO 639-1 codes (ko, en, ja, zh, etc.)',
    gemini_api_key: 'Google Gemini API key for subtitle translation. Get one at aistudio.google.com',
    openai_api_key: 'OpenAI API key for Whisper API and GPT translation. Used for both transcription and translation.',
    deepl_api_key: 'DeepL API key for translation. Supports the free tier API.',
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <SettingsIcon className="w-6 h-6 text-gray-400" />
        <h1 className="text-xl font-semibold text-white">Settings</h1>
      </div>

      {Object.entries(groups).map(([group, items]) => (
        <div key={group} className="mb-6">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">
            {groupLabels[group] || group}
          </h2>

          <div className="bg-dark-900 border border-dark-700 rounded-lg divide-y divide-dark-700">
            {items.map((setting) => (
              <div key={setting.key} className="px-4 py-3">
                <label className="block text-sm font-medium text-gray-200 mb-1">
                  {setting.label}
                  {setting.has_value && (
                    <span className="ml-2 text-xs text-green-500">configured</span>
                  )}
                </label>
                <div className="relative">
                  <input
                    type={setting.secret && !visibleKeys.has(setting.key) ? 'password' : 'text'}
                    value={values[setting.key] || ''}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [setting.key]: e.target.value }))
                    }
                    placeholder={setting.placeholder}
                    className="w-full bg-dark-800 border border-dark-600 rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-primary-500 pr-10"
                  />
                  {setting.secret && (
                    <button
                      type="button"
                      onClick={() => toggleVisibility(setting.key)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                    >
                      {visibleKeys.has(setting.key) ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  )}
                </div>
                {settingHelp[setting.key] && (
                  <p className="text-xs text-gray-500 mt-1">
                    {settingHelp[setting.key]}
                  </p>
                )}
              </div>
            ))}
          </div>

          {/* Show Backend Manager + Model Manager after whisper settings group */}
          {group === 'whisper' && (
            <>
              <div className="mt-4">
                <h3 className="text-sm font-medium text-gray-400 mb-3">
                  Whisper Backends
                </h3>
                <WhisperBackendManager />
              </div>
              <div className="mt-4">
                <h3 className="text-sm font-medium text-gray-400 mb-3">
                  Whisper Models
                </h3>
                <WhisperModelManager />
              </div>
            </>
          )}
        </div>
      ))}

      {error && (
        <div className="text-sm text-red-400 mb-3">{error}</div>
      )}

      <button
        onClick={handleSave}
        disabled={saving}
        className="flex items-center gap-2 bg-primary-600 hover:bg-primary-500 disabled:bg-gray-700 text-white px-4 py-2 rounded-lg text-sm transition-colors"
      >
        {saving ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : saved ? (
          <Check className="w-4 h-4" />
        ) : (
          <Save className="w-4 h-4" />
        )}
        {saved ? 'Saved!' : 'Save Settings'}
      </button>

      <p className="text-xs text-gray-600 mt-4">
        Settings are stored in the database. All changes take effect on the next transcription/translation job.
        Whisper backends can be managed above without restarting the server.
      </p>
    </div>
  )
}
