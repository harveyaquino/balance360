import { useCallback, useState } from 'react'

const MAX_LEN = 120
const INJECTION_RE = /ignore\s+(previous|above|all)\s+instructions|system\s*prompt|<\s*script|javascript:/i

function sanitizeClient(input) {
  if (typeof input !== 'string') return null
  const value = input.trim()
  if (!value || value.length < 2 || value.length > MAX_LEN) return null
  if (INJECTION_RE.test(value)) return null
  return value.replace(/[<>"'`\\]/g, '').slice(0, MAX_LEN)
}

export function useBalance360() {
  const [status, setStatus] = useState('idle')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [steps, setSteps] = useState([])
  const [fromCache, setFromCache] = useState(false)

  const analyze = useCallback(async (rawInput, options = {}) => {
    setStatus('loading')
    setData(null)
    setError(null)
    setSteps([])
    setFromCache(false)

    const clean = sanitizeClient(rawInput)
    if (!clean) {
      setError('Nombre de empresa inválido. Usa entre 2 y 120 caracteres.')
      setStatus('error')
      return
    }

    const fakeSteps = [
      `Consultando cache para "${clean}"...`,
      'Buscando presencia digital...',
      'Analizando reviews y ratings...',
      'Revisando redes sociales...',
      'Calculando BALANCE Score...'
    ]

    let index = 0
    const timer = setInterval(() => {
      if (index < fakeSteps.length) {
        setSteps((previous) => [...previous, fakeSteps[index]])
        index += 1
        return
      }
      clearInterval(timer)
    }, 800)

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {})
        },
        body: JSON.stringify({
          company: clean,
          workspaceId: options.workspaceId || null,
          companyId: options.companyId || null,
          requestType: options.requestType || 'single_audit'
        })
      })

      clearInterval(timer)

      if (response.status === 429) {
        setError('Límite de consultas alcanzado. Intenta en 60 segundos.')
        setStatus('error')
        return null
      }

      if (response.status === 403) {
        const body = await response.json().catch(() => ({}))
        setError(body.error || 'Tu plan actual no permite más análisis en este período.')
        setStatus('error')
        return null
      }

      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        setError(body.error || 'Error al analizar. Intenta de nuevo.')
        setStatus('error')
        return null
      }

      const result = await response.json()
      if (result.pasos?.length) setSteps(result.pasos)
      setFromCache(result.from_cache === true)
      setData(result)
      setStatus('success')
      return result
    } catch {
      clearInterval(timer)
      setError('Error de conexión. Verifica tu red e intenta de nuevo.')
      setStatus('error')
      return null
    }
  }, [])

  const reset = useCallback(() => {
    setStatus('idle')
    setData(null)
    setError(null)
    setSteps([])
    setFromCache(false)
  }, [])

  return { status, data, error, steps, fromCache, analyze, reset }
}
