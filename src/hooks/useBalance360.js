// src/hooks/useBalance360.js
import { useState, useCallback } from 'react'

const MAX_LEN       = 120
const INJECTION_RE  = /ignore\s+(previous|above|all)\s+instructions|system\s*prompt|<\s*script|javascript:/i

function sanitizeClient(input) {
  if (typeof input !== 'string') return null
  const t = input.trim()
  if (!t || t.length < 2 || t.length > MAX_LEN) return null
  if (INJECTION_RE.test(t)) return null
  return t.replace(/[<>"'`\\]/g, '').slice(0, MAX_LEN)
}

export function useBalance360() {
  const [status,    setStatus]    = useState('idle')
  const [data,      setData]      = useState(null)
  const [error,     setError]     = useState(null)
  const [steps,     setSteps]     = useState([])
  const [fromCache, setFromCache] = useState(false)

  const analyze = useCallback(async (rawInput) => {
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

    // Pasos visuales mientras carga
    const fakeSteps = [
      `Consultando cache para "${clean}"...`,
      'Buscando presencia digital...',
      'Analizando reviews y ratings...',
      'Revisando redes sociales...',
      'Calculando BALANCE Score...'
    ]
    let idx = 0
    const timer = setInterval(() => {
      if (idx < fakeSteps.length) setSteps(prev => [...prev, fakeSteps[idx++]])
      else clearInterval(timer)
    }, 800)

    try {
      const res = await fetch('/api/analyze', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ company: clean })
      })

      clearInterval(timer)

      if (res.status === 429) {
        setError('Límite de consultas alcanzado. Intenta en 60 segundos.')
        setStatus('error')
        return
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error || 'Error al analizar. Intenta de nuevo.')
        setStatus('error')
        return
      }

      const result = await res.json()

      if (result.pasos?.length) setSteps(result.pasos)
      setFromCache(result.from_cache === true)
      setData(result)
      setStatus('success')

    } catch (err) {
      clearInterval(timer)
      setError('Error de conexión. Verifica tu red e intenta de nuevo.')
      setStatus('error')
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
