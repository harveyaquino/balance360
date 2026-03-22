// src/App.jsx
import DOMPurify from 'dompurify'
import { useState } from 'react'
import { useArgos } from './hooks/useBalance360'
import { ScoreRing } from './components/ScoreRing'
import { FrenteCard } from './components/FrenteCard'
import { AgentSteps } from './components/AgentSteps'

const FRENTES_ORDER = ['app', 'web', 'rrss', 'reviews', 'google_business']

function Header() {
  return (
    <header className="border-b border-balance360-border px-6 py-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="relative">
          <div className="w-8 h-8 rounded-lg bg-balance360-accent/10 border border-balance360-accent/30 flex items-center justify-center">
            <span className="text-balance360-accent font-mono text-sm font-bold">A</span>
          </div>
          <div className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-balance360-success animate-pulse-slow" />
        </div>
        <div>
          <h1 className="text-balance360-text font-semibold text-sm tracking-wide">BALANCE360</h1>
          <p className="text-balance360-muted text-xs">360° Digital Intelligence</p>
        </div>
      </div>
      <a
        href="https://www.linkedin.com/in/harveyaquinomas/"
        target="_blank"
        rel="noopener noreferrer"
        className="text-balance360-muted text-xs hover:text-balance360-accent transition-colors"
      >
        VeyharCorp
      </a>
    </header>
  )
}

function Hero({ onAnalyze, loading }) {
  const [input, setInput] = useState('')

  const handleSubmit = (e) => {
    e.preventDefault()
    if (input.trim() && !loading) onAnalyze(input)
  }

  return (
    <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
      <div className="mb-3">
        <span className="text-balance360-accent font-mono text-xs uppercase tracking-widest">
          VeyharCorp · Inteligencia Digital
        </span>
      </div>
      <h2 className="text-3xl md:text-5xl font-semibold text-balance360-text mb-4 leading-tight">
        Audita cualquier<br />
        <span className="text-balance360-accent">producto digital</span>
      </h2>
      <p className="text-balance360-muted text-base max-w-md mb-10">
        BALANCE360 analiza apps, web, reviews y redes sociales de empresas grandes
        y genera un informe de inteligencia 360° en segundos.
      </p>
      <form onSubmit={handleSubmit} className="w-full max-w-lg flex gap-3">
        <input
          type="text"
          className="balance360-input"
          placeholder="Ej: BCP, Falabella, Claro..."
          value={input}
          onChange={e => setInput(e.target.value)}
          maxLength={120}
          disabled={loading}
          autoFocus
          aria-label="Nombre de empresa"
        />
        <button
          type="submit"
          className="balance360-btn whitespace-nowrap"
          disabled={!input.trim() || loading}
        >
          {loading ? 'Analizando...' : 'Analizar →'}
        </button>
      </form>
      <p className="text-balance360-muted text-xs mt-4">
        Bancos · Retail · Telco · Seguros · FinTech
      </p>
    </div>
  )
}

function Results({ data, fromCache, onReset }) {
  const safe = (str) => DOMPurify.sanitize(String(str || ''), { ALLOWED_TAGS: [] })

  return (
    <div className="max-w-4xl mx-auto px-4 pb-16 animate-fade-in-up">

      <div className="balance360-card p-6 mb-6 flex flex-col md:flex-row gap-6 items-start md:items-center">
        <ScoreRing score={data.score} size={130} />
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-balance360-muted text-xs font-mono uppercase tracking-widest">
              {safe(data.sector)}
            </span>
            {fromCache && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-balance360-accent/10 text-balance360-accent border border-balance360-accent/20 font-mono">
                desde cache
              </span>
            )}
          </div>
          <h2 className="text-2xl font-semibold text-balance360-text mb-2">
            {safe(data.company)}
          </h2>
          {data.voz_usuario && (
            <p className="text-balance360-muted text-sm leading-relaxed mb-3">
              {safe(data.voz_usuario)}
            </p>
          )}
          {data.gap_principal && (
            <div className="flex items-start gap-2 bg-balance360-danger/10 border border-balance360-danger/20 rounded-lg p-3">
              <span className="text-balance360-danger text-xs font-mono mt-0.5 shrink-0">GAP</span>
              <span className="text-balance360-text text-sm">{safe(data.gap_principal)}</span>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        {FRENTES_ORDER.map(key =>
          data.frentes?.[key]
            ? <FrenteCard key={key} name={key} data={data.frentes[key]} />
            : null
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        <button
          onClick={onReset}
          className="balance360-btn bg-transparent border border-balance360-border text-balance360-text hover:bg-balance360-surface"
        >
          ← Nueva consulta
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const { status, data, error, steps, fromCache, analyze, reset } = useArgos()

  return (
    <div className="min-h-screen bg-balance360-bg flex flex-col">
      <Header />

      <main className="flex-1">
        {status === 'idle' && (
          <Hero onAnalyze={analyze} loading={false} />
        )}

        {status === 'loading' && (
          <div className="max-w-2xl mx-auto px-4 py-12 space-y-6">
            <Hero onAnalyze={analyze} loading={true} />
            <AgentSteps steps={steps} loading={true} />
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center justify-center py-20 px-6 gap-4">
            <div className="balance360-card p-6 text-center max-w-md">
              <p className="text-balance360-danger text-sm mb-4">{error}</p>
              <button onClick={reset} className="balance360-btn">Intentar de nuevo</button>
            </div>
          </div>
        )}

        {status === 'success' && data && (
          <>
            {steps.length > 0 && (
              <div className="max-w-4xl mx-auto px-4 pt-8 pb-4">
                <AgentSteps steps={steps} loading={false} />
              </div>
            )}
            <Results data={data} fromCache={fromCache} onReset={reset} />
          </>
        )}
      </main>

      <footer className="border-t border-balance360-border px-6 py-4 text-center">
        <p className="text-balance360-muted text-xs">
          Creado por{' '}
          <a
            href="https://www.linkedin.com/in/harveyaquinomas/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-balance360-accent hover:underline"
          >
            Harvey Aquino
          </a>
          {' '}· VeyharCorp · BALANCE360 v0.3.0
        </p>
      </footer>
    </div>
  )
}
