import DOMPurify from 'dompurify'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useBalance360 } from './hooks/useBalance360'
import { ScoreRing } from './components/ScoreRing'
import { FrenteCard } from './components/FrenteCard'
import { AgentSteps } from './components/AgentSteps'
import { supabase } from './lib/supabase'
import { completeOnboarding, finalizeOnboarding, getAppContext } from './lib/app'

const FRENTES_ORDER = ['app', 'web', 'rrss', 'reviews', 'google_business', 'organic_mentions']

function safeText(value) {
  return DOMPurify.sanitize(String(value || ''), { ALLOWED_TAGS: [] })
}

function formatDate(value) {
  if (!value) return ''
  try {
    return new Intl.DateTimeFormat('es-CO', {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(value))
  } catch {
    return value
  }
}

function Header({ session, workspaceName, onSignOut }) {
  return (
    <header className="border-b border-balance360-border px-6 py-4 flex items-center justify-between gap-4">
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

      <div className="flex items-center gap-3">
        {workspaceName && (
          <div className="hidden md:block text-right">
            <p className="text-balance360-text text-xs font-mono uppercase tracking-widest">
              {workspaceName}
            </p>
            <p className="text-balance360-muted text-xs">Workspace activo</p>
          </div>
        )}

        {session ? (
          <button
            onClick={onSignOut}
            className="text-balance360-muted text-xs hover:text-balance360-accent transition-colors"
          >
            Cerrar sesión
          </button>
        ) : (
          <a
            href="https://www.linkedin.com/in/harveyaquinomas/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-balance360-muted text-xs hover:text-balance360-accent transition-colors"
          >
            VeyharCorp
          </a>
        )}
      </div>
    </header>
  )
}

function Hero({ onAnalyze, loading }) {
  const [input, setInput] = useState('')

  const handleSubmit = (event) => {
    event.preventDefault()
    if (input.trim() && !loading) onAnalyze(input)
  }

  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <div className="mb-3">
        <span className="text-balance360-accent font-mono text-xs uppercase tracking-widest">
          VeyharCorp · Inteligencia Competitiva Digital
        </span>
      </div>
      <h2 className="text-3xl md:text-5xl font-semibold text-balance360-text mb-4 leading-tight">
        Audita cualquier
        <br />
        <span className="text-balance360-accent">producto digital</span>
      </h2>
      <p className="text-balance360-muted text-base max-w-2xl mb-10">
        BALANCE360 evalúa apps, web, reviews, redes sociales, Google Business y
        menciones orgánicas para darte una lectura ejecutiva del estado digital de una empresa.
      </p>
      <form onSubmit={handleSubmit} className="w-full max-w-lg flex gap-3">
        <input
          type="text"
          className="balance360-input"
          placeholder="Ej: BCP, Falabella, Claro..."
          value={input}
          onChange={(event) => setInput(event.target.value)}
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
  return (
    <div className="max-w-4xl mx-auto px-4 pb-16 animate-fade-in-up">
      <div className="balance360-card p-6 mb-6 flex flex-col md:flex-row gap-6 items-start md:items-center">
        <ScoreRing score={data.score} size={130} />
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-balance360-muted text-xs font-mono uppercase tracking-widest">
              {safeText(data.sector)}
            </span>
            {fromCache && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-balance360-accent/10 text-balance360-accent border border-balance360-accent/20 font-mono">
                desde cache
              </span>
            )}
          </div>
          <h2 className="text-2xl font-semibold text-balance360-text mb-2">
            {safeText(data.company)}
          </h2>
          {data.voz_usuario && (
            <p className="text-balance360-muted text-sm leading-relaxed mb-3">
              {safeText(data.voz_usuario)}
            </p>
          )}
          {data.gap_principal && (
            <div className="flex items-start gap-2 bg-balance360-danger/10 border border-balance360-danger/20 rounded-lg p-3">
              <span className="text-balance360-danger text-xs font-mono mt-0.5 shrink-0">GAP</span>
              <span className="text-balance360-text text-sm">{safeText(data.gap_principal)}</span>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        {FRENTES_ORDER.map((key) =>
          data.frentes?.[key] ? <FrenteCard key={key} name={key} data={data.frentes[key]} /> : null
        )}
      </div>

      <div className="flex justify-center">
        <button
          onClick={onReset}
          className="balance360-btn bg-transparent border border-balance360-border text-balance360-text hover:bg-balance360-surface"
        >
          Limpiar resultado
        </button>
      </div>
    </div>
  )
}

function AuthPanel({ mode, form, loading, error, message, onModeChange, onChange, onSubmit }) {
  return (
    <div className="balance360-card p-6 w-full max-w-md">
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => onModeChange('signin')}
          className={`px-3 py-2 rounded-md text-sm ${mode === 'signin' ? 'bg-balance360-accent text-balance360-bg' : 'bg-balance360-surface text-balance360-text'}`}
        >
          Iniciar sesión
        </button>
        <button
          onClick={() => onModeChange('signup')}
          className={`px-3 py-2 rounded-md text-sm ${mode === 'signup' ? 'bg-balance360-accent text-balance360-bg' : 'bg-balance360-surface text-balance360-text'}`}
        >
          Crear cuenta
        </button>
      </div>

      <h3 className="text-balance360-text text-xl font-semibold mb-2">
        {mode === 'signup' ? 'Activa tu workspace' : 'Entra a tu dashboard'}
      </h3>
      <p className="text-balance360-muted text-sm mb-5">
        {mode === 'signup'
          ? 'Regístrate para crear tu workspace, configurar tu empresa y lanzar el primer análisis.'
          : 'Usa tu cuenta para continuar con onboarding, historial y análisis persistentes.'}
      </p>

      <form className="space-y-3" onSubmit={onSubmit}>
        {mode === 'signup' && (
          <>
            <input
              className="balance360-input"
              placeholder="Nombre completo"
              value={form.fullName}
              onChange={(event) => onChange('fullName', event.target.value)}
              disabled={loading}
            />
            <input
              className="balance360-input"
              placeholder="Empresa"
              value={form.companyName}
              onChange={(event) => onChange('companyName', event.target.value)}
              disabled={loading}
            />
          </>
        )}
        <input
          type="email"
          className="balance360-input"
          placeholder="Correo corporativo"
          value={form.email}
          onChange={(event) => onChange('email', event.target.value)}
          disabled={loading}
        />
        <input
          type="password"
          className="balance360-input"
          placeholder="Contraseña"
          value={form.password}
          onChange={(event) => onChange('password', event.target.value)}
          disabled={loading}
        />
        <button type="submit" className="balance360-btn w-full" disabled={loading}>
          {loading ? 'Procesando...' : mode === 'signup' ? 'Crear cuenta' : 'Entrar'}
        </button>
      </form>

      {message && <p className="text-balance360-accent text-sm mt-4">{message}</p>}
      {error && <p className="text-balance360-danger text-sm mt-4">{error}</p>}
    </div>
  )
}

function OnboardingPanel({
  form,
  loading,
  error,
  steps,
  onChange,
  onSubmit
}) {
  return (
    <div className="max-w-5xl mx-auto px-4 py-12 grid lg:grid-cols-[1.1fr,0.9fr] gap-6">
      <div className="balance360-card p-8">
        <p className="text-balance360-accent text-xs font-mono uppercase tracking-widest mb-3">
          Onboarding guiado
        </p>
        <h2 className="text-3xl font-semibold text-balance360-text mb-3">
          Configura tu primer análisis
        </h2>
        <p className="text-balance360-muted text-sm mb-6">
          Dinos qué empresa analizas, en qué sector compite y cuál es su rival principal.
          BALANCE360 usará esta información para preparar el primer benchmark.
        </p>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-balance360-muted text-xs uppercase tracking-wider mb-2">
              Empresa
            </label>
            <input
              className="balance360-input"
              value={form.companyName}
              onChange={(event) => onChange('companyName', event.target.value)}
              placeholder="Ej: BCP"
              disabled={loading}
            />
          </div>
          <div>
            <label className="block text-balance360-muted text-xs uppercase tracking-wider mb-2">
              Sector
            </label>
            <input
              className="balance360-input"
              value={form.sector}
              onChange={(event) => onChange('sector', event.target.value)}
              placeholder="Ej: Banca"
              disabled={loading}
            />
          </div>
          <div>
            <label className="block text-balance360-muted text-xs uppercase tracking-wider mb-2">
              Competidor principal
            </label>
            <input
              className="balance360-input"
              value={form.primaryCompetitor}
              onChange={(event) => onChange('primaryCompetitor', event.target.value)}
              placeholder="Ej: BBVA"
              disabled={loading}
            />
          </div>
          <div>
            <label className="block text-balance360-muted text-xs uppercase tracking-wider mb-2">
              Cargo
            </label>
            <input
              className="balance360-input"
              value={form.jobTitle}
              onChange={(event) => onChange('jobTitle', event.target.value)}
              placeholder="Ej: Director Digital"
              disabled={loading}
            />
          </div>
          <button type="submit" className="balance360-btn w-full" disabled={loading}>
            {loading ? 'Preparando onboarding...' : 'Crear contexto y lanzar primer análisis'}
          </button>
        </form>

        {error && <p className="text-balance360-danger text-sm mt-4">{error}</p>}
      </div>

      <div className="space-y-6">
        <div className="balance360-card p-6">
          <h3 className="text-balance360-text font-semibold mb-3">Qué se activará</h3>
          <ul className="space-y-2 text-sm text-balance360-muted">
            <li>1. Se crea tu empresa principal dentro del workspace.</li>
            <li>2. Se registra el competidor principal para benchmark.</li>
            <li>3. Se ejecuta el primer análisis y se guarda en historial.</li>
          </ul>
        </div>
        <AgentSteps steps={steps} loading={loading} />
      </div>
    </div>
  )
}

function Dashboard({
  profile,
  workspace,
  companies,
  history,
  selectedCompanyId,
  onCompanyChange,
  onAnalyze,
  loading
}) {
  const selectedCompany = companies.find((item) => item.id === selectedCompanyId) || companies[0] || null

  return (
    <div className="max-w-6xl mx-auto px-4 py-10 space-y-6">
      <section className="grid lg:grid-cols-[1.1fr,0.9fr] gap-6">
        <div className="balance360-card p-8">
          <p className="text-balance360-accent text-xs font-mono uppercase tracking-widest mb-3">
            Dashboard personal
          </p>
          <h2 className="text-3xl font-semibold text-balance360-text mb-3">
            Bienvenido, {safeText(profile?.display_name || 'equipo')}
          </h2>
          <p className="text-balance360-muted text-sm mb-6">
            Tienes el plan <span className="text-balance360-text font-semibold uppercase">{safeText(profile?.plan)}</span> y has usado{' '}
            <span className="text-balance360-text font-semibold">{profile?.queries_used ?? 0}</span> de{' '}
            <span className="text-balance360-text font-semibold">{profile?.queries_limit ?? 0}</span> análisis en este período.
          </p>

          <div className="grid sm:grid-cols-2 gap-4 mb-6">
            <div className="bg-balance360-surface border border-balance360-border rounded-xl p-4">
              <p className="text-balance360-muted text-xs uppercase tracking-wider mb-1">Workspace</p>
              <p className="text-balance360-text font-semibold">{safeText(workspace?.name || 'Sin nombre')}</p>
            </div>
            <div className="bg-balance360-surface border border-balance360-border rounded-xl p-4">
              <p className="text-balance360-muted text-xs uppercase tracking-wider mb-1">Próximo reset</p>
              <p className="text-balance360-text font-semibold">{formatDate(profile?.reset_at)}</p>
            </div>
          </div>

          <div className="space-y-3">
            <label className="block text-balance360-muted text-xs uppercase tracking-wider">
              Empresa activa
            </label>
            <div className="flex flex-col md:flex-row gap-3">
              <select
                className="balance360-input"
                value={selectedCompanyId || ''}
                onChange={(event) => onCompanyChange(event.target.value)}
                disabled={!companies.length || loading}
              >
                {companies.length === 0 && <option value="">No hay empresas aún</option>}
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
              <button
                className="balance360-btn whitespace-nowrap"
                onClick={() => selectedCompany && onAnalyze(selectedCompany)}
                disabled={!selectedCompany || loading}
              >
                {loading ? 'Analizando...' : 'Actualizar análisis'}
              </button>
            </div>
            {selectedCompany && (
              <p className="text-balance360-muted text-sm">
                Sector: {safeText(selectedCompany.sector || 'Sin sector')} · slug: {safeText(selectedCompany.slug)}
              </p>
            )}
          </div>
        </div>

        <div className="balance360-card p-6">
          <h3 className="text-balance360-text font-semibold mb-4">Historial reciente</h3>
          <div className="space-y-3">
            {history.length === 0 && (
              <p className="text-balance360-muted text-sm">
                Todavía no hay auditorías guardadas para este usuario.
              </p>
            )}
            {history.map((item) => (
              <div key={item.id} className="bg-balance360-surface border border-balance360-border rounded-xl p-4">
                <div className="flex items-center justify-between gap-3 mb-1">
                  <p className="text-balance360-text font-semibold">{safeText(item.company)}</p>
                  <span className="text-balance360-accent font-mono text-sm">{item.score}</span>
                </div>
                <p className="text-balance360-muted text-xs">
                  {safeText(item.sector || 'Sin sector')} · {formatDate(item.created_at)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}

function LoadingScreen({ label }) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-6">
      <div className="balance360-card p-8 text-center max-w-md w-full">
        <div className="w-12 h-12 rounded-full border-2 border-balance360-border border-t-balance360-accent mx-auto mb-4 animate-spin" />
        <p className="text-balance360-text font-semibold mb-2">Cargando BALANCE360</p>
        <p className="text-balance360-muted text-sm">{label}</p>
      </div>
    </div>
  )
}

export default function App() {
  const balance = useBalance360()
  const [booting, setBooting] = useState(true)
  const [contextLoading, setContextLoading] = useState(false)
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [workspace, setWorkspace] = useState(null)
  const [companies, setCompanies] = useState([])
  const [history, setHistory] = useState([])
  const [onboardingState, setOnboardingState] = useState(null)
  const [selectedCompanyId, setSelectedCompanyId] = useState('')

  const [authMode, setAuthMode] = useState('signup')
  const [authForm, setAuthForm] = useState({
    fullName: '',
    companyName: '',
    email: '',
    password: ''
  })
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState('')
  const [authMessage, setAuthMessage] = useState('')

  const [onboardingForm, setOnboardingForm] = useState({
    companyName: '',
    sector: '',
    primaryCompetitor: '',
    jobTitle: ''
  })
  const [onboardingLoading, setOnboardingLoading] = useState(false)
  const [onboardingError, setOnboardingError] = useState('')

  const loadContext = useCallback(async (userId) => {
    setContextLoading(true)
    try {
      const context = await getAppContext(userId)
      setProfile(context.profile)
      setWorkspace(context.workspace)
      setCompanies(context.companies)
      setHistory(context.history)
      setOnboardingState(context.onboarding)
      setSelectedCompanyId((previous) => previous || context.companies[0]?.id || '')

      setOnboardingForm((previous) => ({
        companyName: context.onboarding?.company_name || context.profile?.company_name || previous.companyName,
        sector: context.onboarding?.sector || previous.sector,
        primaryCompetitor: context.onboarding?.primary_competitor || previous.primaryCompetitor,
        jobTitle: context.profile?.job_title || previous.jobTitle
      }))
    } finally {
      setContextLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true

    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return
      const currentSession = data.session || null
      setSession(currentSession)
      if (currentSession?.user) {
        await loadContext(currentSession.user.id)
      }
      if (active) setBooting(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)

      if (!nextSession?.user) {
        setProfile(null)
        setWorkspace(null)
        setCompanies([])
        setHistory([])
        setOnboardingState(null)
        setSelectedCompanyId('')
        setBooting(false)
        return
      }

      loadContext(nextSession.user.id).finally(() => setBooting(false))
    })

    return () => {
      active = false
      listener.subscription.unsubscribe()
    }
  }, [loadContext])

  const workspaceName = useMemo(() => workspace?.name || profile?.company_name || '', [workspace, profile])

  const handleAuthChange = (field, value) => {
    setAuthForm((previous) => ({ ...previous, [field]: value }))
  }

  const handleAuthSubmit = async (event) => {
    event.preventDefault()
    setAuthLoading(true)
    setAuthError('')
    setAuthMessage('')

    try {
      if (authMode === 'signup') {
        const redirectTo = window.location.origin
        const { error, data } = await supabase.auth.signUp({
          email: authForm.email.trim(),
          password: authForm.password,
          options: {
            emailRedirectTo: redirectTo,
            data: {
              full_name: authForm.fullName.trim(),
              company_name: authForm.companyName.trim()
            }
          }
        })

        if (error) throw error

        if (!data.session) {
          setAuthMessage('Te enviamos un correo de verificación. Confirma tu email para entrar.')
        } else {
          setAuthMessage('Cuenta creada correctamente. Estamos preparando tu workspace.')
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: authForm.email.trim(),
          password: authForm.password
        })

        if (error) throw error
      }
    } catch (error) {
      setAuthError(error.message || 'No fue posible completar la autenticación.')
    } finally {
      setAuthLoading(false)
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    balance.reset()
  }

  const handleGuestAnalyze = async (company) => {
    await balance.analyze(company)
  }

  const handleDashboardAnalyze = async (company) => {
    const accessToken = session?.access_token
    if (!accessToken) return

    await balance.analyze(company.name, {
      accessToken,
      workspaceId: workspace?.id,
      companyId: company.id,
      requestType: 'single_audit'
    })
    if (session?.user?.id) await loadContext(session.user.id)
  }

  const handleOnboardingChange = (field, value) => {
    setOnboardingForm((previous) => ({ ...previous, [field]: value }))
  }

  const handleOnboardingSubmit = async (event) => {
    event.preventDefault()

    if (!session?.user || !workspace?.id) {
      setOnboardingError('No encontramos un workspace activo para este usuario.')
      return
    }

    if (!onboardingForm.companyName.trim() || !onboardingForm.sector.trim()) {
      setOnboardingError('Completa al menos empresa y sector para continuar.')
      return
    }

    setOnboardingLoading(true)
    setOnboardingError('')

    try {
      const company = await completeOnboarding({
        userId: session.user.id,
        workspaceId: workspace.id,
        companyName: onboardingForm.companyName,
        sector: onboardingForm.sector,
        primaryCompetitor: onboardingForm.primaryCompetitor,
        jobTitle: onboardingForm.jobTitle
      })

      const result = await balance.analyze(onboardingForm.companyName, {
        accessToken: session.access_token,
        workspaceId: workspace.id,
        companyId: company.id,
        requestType: 'onboarding_audit'
      })

      if (!result?.audit_id) {
        throw new Error('El análisis inicial no devolvió un audit_id persistente.')
      }

      await finalizeOnboarding({
        userId: session.user.id,
        workspaceId: workspace.id,
        companyId: company.id,
        auditId: result.audit_id
      })

      await loadContext(session.user.id)
      setSelectedCompanyId(company.id)
    } catch (error) {
      setOnboardingError(error.message || 'No fue posible completar el onboarding.')
    } finally {
      setOnboardingLoading(false)
    }
  }

  const onboardingCompleted = profile?.onboarding_completed === true || onboardingState?.step === 'completed'

  return (
    <div className="min-h-screen bg-balance360-bg flex flex-col">
      <Header
        session={session}
        workspaceName={workspaceName}
        onSignOut={handleSignOut}
      />

      <main className="flex-1">
        {booting && <LoadingScreen label="Inicializando sesión y contexto de datos..." />}

        {!booting && !session && (
          <>
            <section className="max-w-6xl mx-auto px-4 py-10 grid lg:grid-cols-[1.15fr,0.85fr] gap-6 items-start">
              <div className="balance360-card">
                <Hero onAnalyze={handleGuestAnalyze} loading={balance.status === 'loading'} />
              </div>
              <AuthPanel
                mode={authMode}
                form={authForm}
                loading={authLoading}
                error={authError}
                message={authMessage}
                onModeChange={setAuthMode}
                onChange={handleAuthChange}
                onSubmit={handleAuthSubmit}
              />
            </section>

            {balance.status === 'loading' && (
              <div className="max-w-4xl mx-auto px-4 pb-6">
                <AgentSteps steps={balance.steps} loading />
              </div>
            )}

            {balance.status === 'error' && (
              <div className="max-w-4xl mx-auto px-4 pb-6">
                <div className="balance360-card p-6 text-center">
                  <p className="text-balance360-danger text-sm">{balance.error}</p>
                </div>
              </div>
            )}

            {balance.status === 'success' && balance.data && (
              <Results data={balance.data} fromCache={balance.fromCache} onReset={balance.reset} />
            )}
          </>
        )}

        {!booting && session && contextLoading && (
          <LoadingScreen label="Cargando perfil, workspace e historial..." />
        )}

        {!booting && session && !contextLoading && !onboardingCompleted && (
          <>
            <OnboardingPanel
              form={onboardingForm}
              loading={onboardingLoading || balance.status === 'loading'}
              error={onboardingError || balance.error}
              steps={balance.steps}
              onChange={handleOnboardingChange}
              onSubmit={handleOnboardingSubmit}
            />

            {balance.status === 'success' && balance.data && (
              <Results data={balance.data} fromCache={balance.fromCache} onReset={balance.reset} />
            )}
          </>
        )}

        {!booting && session && !contextLoading && onboardingCompleted && (
          <>
            <Dashboard
              profile={profile}
              workspace={workspace}
              companies={companies}
              history={history}
              selectedCompanyId={selectedCompanyId}
              onCompanyChange={setSelectedCompanyId}
              onAnalyze={handleDashboardAnalyze}
              loading={balance.status === 'loading'}
            />

            {balance.steps.length > 0 && (
              <div className="max-w-4xl mx-auto px-4 pb-4">
                <AgentSteps steps={balance.steps} loading={balance.status === 'loading'} />
              </div>
            )}

            {balance.status === 'error' && (
              <div className="max-w-4xl mx-auto px-4 pb-6">
                <div className="balance360-card p-6 text-center">
                  <p className="text-balance360-danger text-sm">{balance.error}</p>
                </div>
              </div>
            )}

            {balance.status === 'success' && balance.data && (
              <Results data={balance.data} fromCache={balance.fromCache} onReset={balance.reset} />
            )}
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
