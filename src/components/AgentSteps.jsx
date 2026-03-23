import DOMPurify from 'dompurify'
import { useEffect, useRef } from 'react'

export function AgentSteps({ steps = [], loading = false }) {
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [steps.length])

  if (!steps.length && !loading) return null

  const safe = (text) => DOMPurify.sanitize(String(text || ''), { ALLOWED_TAGS: [] })

  return (
    <div className="balance360-card p-5 font-mono text-xs space-y-2 max-h-56 overflow-y-auto">
      <p className="text-balance360-muted uppercase tracking-widest text-xs mb-3">
        Progreso del análisis
      </p>
      {steps.map((step, index) => (
        <div key={index} className="step-item animate-fade-in-up">
          <span className="text-balance360-accent mt-0.5 shrink-0">›</span>
          <span className="text-balance360-text">{safe(step)}</span>
        </div>
      ))}
      {loading && (
        <div className="flex items-center gap-2 text-balance360-muted">
          <span className="text-balance360-accent">›</span>
          <span>Procesando<span className="cursor-blink">_</span></span>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}
