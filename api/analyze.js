import { createClient } from '@supabase/supabase-js'
import { buildSignalsSummary, collectPublicSignals } from './lib/sources.js'

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''
const MAX_INPUT_LENGTH = 120
const RATE_LIMIT_WINDOW = 60_000
const RATE_LIMIT_MAX = 10
const CACHE_TTL_DAYS = 7
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest'

const rateLimitMap = new Map()

function getRateLimit(ip) {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)

  if (!entry || now - entry.timestamp > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { count: 1, timestamp: now })
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 }
  }

  if (entry.count >= RATE_LIMIT_MAX) return { allowed: false, remaining: 0 }

  entry.count += 1
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count }
}

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function sanitizeInput(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value || value.length < 2 || value.length > MAX_INPUT_LENGTH) return null

  const injectionPatterns = [
    /ignore\s+(previous|above|all)\s+instructions/i,
    /system\s*prompt/i,
    /you\s+are\s+now/i,
    /forget\s+(everything|all)/i,
    /<\s*script/i,
    /javascript:/i,
    /\beval\s*\(/i
  ]

  if (injectionPatterns.some((pattern) => pattern.test(value))) return null
  return value.replace(/[<>"'`\\]/g, '').slice(0, MAX_INPUT_LENGTH)
}

function sanitizeUuid(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return UUID_RE.test(value) ? value : null
}

function corsHeaders(origin) {
  const isDev = process.env.NODE_ENV === 'development'
  const allowed = !ALLOWED_ORIGIN || origin === ALLOWED_ORIGIN || isDev

  return {
    'Access-Control-Allow-Origin': allowed ? (origin || '*') : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  }
}

function applyHeaders(res, headers) {
  Object.entries(headers).forEach(([key, value]) => {
    res.setHeader(key, value)
  })
  return res
}

function normalizeText(value, fallback = '') {
  if (typeof value !== 'string') return fallback
  return value.trim()
}

function normalizeList(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => normalizeText(item)).filter(Boolean).slice(0, 6)
}

function normalizeScore(value, fallback = 0) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.min(100, Math.round(parsed)))
}

function pickFront(source, aliases) {
  if (!source || typeof source !== 'object') return null
  for (const alias of aliases) {
    if (source[alias]) return source[alias]
  }
  return null
}

function normalizeFront(front, fallbackLabel) {
  const source = front && typeof front === 'object' ? front : {}
  return {
    label: normalizeText(source.label, fallbackLabel),
    score: normalizeScore(source.score, 0),
    hallazgos: normalizeList(source.hallazgos),
    oportunidades: normalizeList(source.oportunidades)
  }
}

function normalizeAuditResult(raw, company) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const frentes = source.frentes && typeof source.frentes === 'object' ? source.frentes : {}

  return {
    company: normalizeText(source.company, company),
    sector: normalizeText(source.sector, 'General'),
    score: normalizeScore(source.score, 0),
    voz_usuario: normalizeText(source.voz_usuario),
    gap_principal: normalizeText(source.gap_principal),
    pasos: normalizeList(source.pasos),
    frentes: {
      app: normalizeFront(pickFront(frentes, ['app', 'mobile_app', 'app_movil']), 'App móvil'),
      web: normalizeFront(pickFront(frentes, ['web', 'website', 'sitio_web']), 'Web'),
      rrss: normalizeFront(pickFront(frentes, ['rrss', 'redes_sociales', 'social', 'social_media']), 'Redes sociales'),
      reviews: normalizeFront(pickFront(frentes, ['reviews', 'ratings']), 'Reviews'),
      google_business: normalizeFront(
        pickFront(frentes, ['google_business', 'google', 'google_maps', 'google_business_profile']),
        'Google Business'
      ),
      organic_mentions: normalizeFront(
        pickFront(frentes, ['organic_mentions', 'organic', 'seo', 'menciones_organicas']),
        'Menciones orgánicas'
      )
    }
  }
}

function extractTextBlocks(apiData) {
  return (apiData.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('No se encontró JSON en la respuesta del agente')
  return JSON.parse(match[0])
}

function buildSystemPrompt(signals) {
  return [
    'Eres BALANCE360, un analista senior de inteligencia competitiva digital para grandes empresas de Latinoamérica.',
    'Debes responder solo con JSON válido, sin markdown, sin comentarios y sin texto adicional.',
    'Evalúa una empresa en seis frentes: app, web, rrss, reviews, google_business y organic_mentions.',
    'Usa únicamente la evidencia entregada. No inventes presencia digital si las señales no aparecen.',
    'Si la evidencia es débil o contradictoria, dilo explícitamente en hallazgos y baja el score.',
    'Cada frente debe incluir score (0 a 100), hallazgos (array) y oportunidades (array).',
    'La respuesta JSON debe usar exactamente esta estructura:',
    '{',
    '  "company": "string",',
    '  "sector": "string",',
    '  "score": 0,',
    '  "voz_usuario": "string",',
    '  "gap_principal": "string",',
    '  "pasos": ["string"],',
    '  "frentes": {',
    '    "app": { "score": 0, "hallazgos": ["string"], "oportunidades": ["string"] },',
    '    "web": { "score": 0, "hallazgos": ["string"], "oportunidades": ["string"] },',
    '    "rrss": { "score": 0, "hallazgos": ["string"], "oportunidades": ["string"] },',
    '    "reviews": { "score": 0, "hallazgos": ["string"], "oportunidades": ["string"] },',
    '    "google_business": { "score": 0, "hallazgos": ["string"], "oportunidades": ["string"] },',
    '    "organic_mentions": { "score": 0, "hallazgos": ["string"], "oportunidades": ["string"] }',
    '  }',
    '}',
    'Si no tienes certeza, infiere con prudencia y deja constancia en hallazgos u oportunidades.',
    'Mantén el lenguaje ejecutivo, concreto y útil para product managers, directores digitales y CMOs.',
    'EVIDENCIA DISPONIBLE:',
    buildSignalsSummary(signals)
  ].join('\n')
}

function buildFallbackAudit(company, signals, details = '') {
  const note = details ? ` Contexto técnico: ${details}` : ''
  const existenceHint = signals?.existenceLikely
    ? `${company} muestra algunas señales públicas, pero el análisis enriquecido no pudo completarse.`
    : `No encontramos señales públicas suficientes para confirmar una presencia digital consistente de ${company}.`
  const hallazgoBase = `${existenceHint}${note}`.trim()
  const baseScore = signals?.confidenceScore
    ? Math.max(18, Math.min(68, Math.round(signals.confidenceScore * 0.7)))
    : 32

  return {
    company,
    sector: 'General',
    score: baseScore,
    voz_usuario: signals?.existenceLikely
      ? `BALANCE360 detectó señales públicas iniciales de ${company}, pero aún faltan fuentes verificadas por frente para consolidar una lectura completa.`
      : `BALANCE360 no encontró evidencia pública suficiente para validar digitalmente a ${company} con confianza.`,
    gap_principal: signals?.existenceLikely
      ? `Hace falta consolidar señales comparables de ${company} frente a sus competidores para obtener un score más preciso.`
      : `Antes de emitir benchmark o insights, necesitamos confirmar si ${company} tiene presencia pública trazable en las fuentes monitoreadas.`,
    pasos: [
      `Inicializando auditoría de ${company}`,
      'Recolectando señales públicas del producto',
      'Aplicando respuesta preliminar basada en evidencia observable'
    ],
    frentes: {
      app: {
        label: 'App móvil',
        score: signals?.app?.found ? 54 : 18,
        hallazgos: [signals?.app?.found
          ? `Encontramos una señal en App Store para ${company}. ${hallazgoBase}`
          : `No encontramos evidencia suficiente de app pública para ${company}. ${note}`.trim()],
        oportunidades: ['Validar presencia real en App Store y Google Play, rating, volumen de reseñas y desempeño funcional.']
      },
      web: {
        label: 'Web',
        score: signals?.web?.found ? 62 : 24,
        hallazgos: [signals?.web?.found
          ? `Detectamos sitio o dominio asociado a ${company}: ${signals.web.url || 'sin URL visible'}.`
          : 'No encontramos una web oficial clara en esta primera pasada.'],
        oportunidades: ['Validar dominio oficial, claridad de navegación, performance y conversión por flujo principal.']
      },
      rrss: {
        label: 'Redes sociales',
        score: signals?.rrss?.count ? Math.min(70, 28 + signals.rrss.count * 12) : 20,
        hallazgos: [signals?.rrss?.count
          ? `Detectamos ${signals.rrss.count} perfiles o señales sociales relacionadas con ${company}.`
          : 'No encontramos perfiles sociales claros en esta pasada pública.'],
        oportunidades: ['Comparar frecuencia, tono y respuesta a usuarios frente a competidores directos.']
      },
      reviews: {
        label: 'Reviews',
        score: signals?.reviews?.found ? 52 : 18,
        hallazgos: [signals?.reviews?.found
          ? 'Hay señales iniciales de reseñas públicas, pero aún falta consolidación cross-platform.'
          : 'No encontramos suficientes reseñas públicas verificadas para sintetizar voz del usuario.'],
        oportunidades: ['Agrupar fricciones repetidas por producto, soporte, pagos y experiencia cuando conectemos fuentes de reviews.']
      },
      google_business: {
        label: 'Google Business',
        score: signals?.google_business?.found ? 58 : 20,
        hallazgos: [signals?.google_business?.found
          ? `Se detectó una posible ficha o resultado de Maps para ${company}.`
          : 'No encontramos una ficha clara de Google Business en esta consulta pública.'],
        oportunidades: ['Auditar reputación local, respuesta a reseñas y consistencia de ficha.']
      },
      organic_mentions: {
        label: 'Menciones orgánicas',
        score: signals?.organic_mentions?.mentionsCount
          ? Math.min(72, 24 + signals.organic_mentions.mentionsCount * 7)
          : 16,
        hallazgos: [signals?.organic_mentions?.mentionsCount
          ? `Detectamos ${signals.organic_mentions.mentionsCount} resultados orgánicos visibles para ${company}.`
          : `No encontramos suficientes menciones orgánicas confiables para ${company}.`],
        oportunidades: ['Monitorear share of voice, SEO de marca y menciones en medios y foros.']
      }
    }
  }
}

function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) return null

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
}

async function getAuthenticatedUser(supabase, authHeader) {
  if (!supabase || !authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice('Bearer '.length).trim()
  if (!token) return null

  try {
    const { data, error } = await supabase.auth.getUser(token)
    if (error) return null
    return data.user || null
  } catch {
    return null
  }
}

async function getCachedAudit(supabase, company) {
  if (!supabase) return null

  const slug = slugify(company)
  const { data, error } = await supabase
    .from('audits')
    .select('*')
    .eq('company_slug', slug)
    .eq('is_public', true)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.warn('[BALANCE360] Error consultando cache:', error.message)
    return null
  }

  return data
}

function isLowQualityCachedAudit(audit) {
  if (!audit) return true

  const voice = String(audit.voz_usuario || '').toLowerCase()
  const gap = String(audit.gap_principal || '').toLowerCase()
  const hallazgos = Object.values(audit.frentes || {})
    .flatMap((front) => Array.isArray(front?.hallazgos) ? front.hallazgos : [])
    .join(' ')
    .toLowerCase()

  const stalePatterns = [
    'contingencia',
    'lectura preliminar',
    'contexto técnico',
    'anthropic',
    'no encontramos señales públicas suficientes',
    'no encontramos evidencia pública suficiente'
  ]

  const combined = `${voice} ${gap} ${hallazgos}`
  return stalePatterns.some((pattern) => combined.includes(pattern))
}

async function resetProfileUsageIfNeeded(supabase, profile) {
  if (!supabase || !profile?.id || !profile.reset_at) return profile
  const now = new Date()
  const resetAt = new Date(profile.reset_at)
  if (Number.isNaN(resetAt.getTime()) || resetAt > now) return profile

  const nextReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  const { data, error } = await supabase
    .from('profiles')
    .update({
      queries_used: 0,
      reset_at: nextReset.toISOString(),
      updated_at: now.toISOString()
    })
    .eq('id', profile.id)
    .select()
    .single()

  if (error) return profile
  return data
}

async function getUserProfile(supabase, userId) {
  if (!supabase || !userId) return null

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle()

  if (error || !data) return null
  return resetProfileUsageIfNeeded(supabase, data)
}

async function createAnalysisRequest(supabase, payload) {
  if (!supabase || !payload.requested_by) return null

  const { data, error } = await supabase
    .from('analysis_requests')
    .insert(payload)
    .select()
    .single()

  if (error) {
    console.warn('[BALANCE360] Error creando analysis_request:', error.message)
    return null
  }

  return data
}

async function updateAnalysisRequest(supabase, requestId, payload) {
  if (!supabase || !requestId) return

  const { error } = await supabase
    .from('analysis_requests')
    .update(payload)
    .eq('id', requestId)

  if (error) {
    console.warn('[BALANCE360] Error actualizando analysis_request:', error.message)
  }
}

async function upsertBenchmark(supabase, result, auditId) {
  if (!supabase || !result.sector || result.score == null) return

  const now = new Date()
  const period = `${now.getFullYear()}-Q${Math.ceil((now.getMonth() + 1) / 3)}`
  const payload = {
    sector: result.sector,
    company: result.company,
    company_slug: slugify(result.company),
    score: result.score,
    audit_id: auditId,
    period
  }

  const { error } = await supabase
    .from('benchmarks')
    .upsert(payload, {
      onConflict: 'sector,company_slug,period',
      ignoreDuplicates: false
    })

  if (error) {
    console.warn('[BALANCE360] Error actualizando benchmark:', error.message)
  }
}

async function incrementUserQueries(supabase, userId) {
  if (!supabase || !userId) return
  const { error } = await supabase.rpc('increment_queries', { uid: userId })
  if (error) {
    console.warn('[BALANCE360] Error incrementando queries:', error.message)
  }
}

async function saveAudit(supabase, result, userId) {
  if (!supabase) return null

  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + CACHE_TTL_DAYS)

  const payload = {
    company: result.company,
    company_slug: slugify(result.company),
    sector: result.sector,
    score: result.score,
    frentes: result.frentes,
    voz_usuario: result.voz_usuario,
    gap_principal: result.gap_principal,
    pasos: result.pasos,
    expires_at: expiresAt.toISOString(),
    is_public: true,
    user_id: userId || null
  }

  const { data, error } = await supabase
    .from('audits')
    .insert(payload)
    .select()
    .single()

  if (error) {
    console.warn('[BALANCE360] Error guardando auditoría:', error.message)
    return null
  }

  await upsertBenchmark(supabase, result, data.id)
  if (userId) await incrementUserQueries(supabase, userId)

  return data
}

async function requestAnthropicAnalysis(apiKey, company, signals) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2500,
      system: buildSystemPrompt(signals),
      messages: [
        {
          role: 'user',
          content: `Genera un análisis ejecutivo de ${company} como producto digital para BALANCE360 usando solo la evidencia disponible.`
        }
      ]
    })
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Anthropic ${response.status}: ${errText.slice(0, 300)}`)
  }

  const apiData = await response.json()
  const fullText = extractTextBlocks(apiData)
  const parsed = extractJson(fullText)
  return normalizeAuditResult(parsed, company)
}

async function handleRequest(req, res) {
  const origin = req.headers.origin || ''
  const headers = corsHeaders(origin)

  if (req.method === 'OPTIONS') {
    applyHeaders(res, headers)
    return res.status(204).end()
  }

  applyHeaders(res, headers)

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown'
  const { allowed, remaining } = getRateLimit(ip)

  if (!allowed) {
    applyHeaders(res, { 'Retry-After': '60' })
    return res
      .status(429)
      .json({ error: 'Demasiadas solicitudes. Intenta en 60 segundos.' })
  }

  res.setHeader('X-RateLimit-Remaining', remaining)

  let body
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  } catch {
    return res.status(400).json({ error: 'Body inválido' })
  }

  const company = sanitizeInput(body?.company)
  const workspaceId = sanitizeUuid(body?.workspaceId)
  const companyId = sanitizeUuid(body?.companyId)
  const requestType = normalizeText(body?.requestType, 'single_audit')

  if (!company) {
    return res.status(400).json({ error: 'Nombre de empresa inválido.' })
  }

  const supabase = getSupabaseClient()
  const authUser = await getAuthenticatedUser(supabase, req.headers.authorization || '')
  const profile = authUser ? await getUserProfile(supabase, authUser.id) : null
  const publicSignals = await collectPublicSignals(company)

  if (
    profile &&
    profile.queries_used >= profile.queries_limit &&
    requestType !== 'onboarding_audit'
  ) {
    return res.status(403).json({
      error: 'Alcanzaste el límite de análisis de tu plan actual. Haz upgrade para continuar.'
    })
  }

  const analysisRequest = await createAnalysisRequest(supabase, {
    workspace_id: workspaceId,
    company_id: companyId,
    requested_by: authUser?.id || null,
    request_type: requestType,
    status: 'running',
    company_name: company,
    company_slug: slugify(company),
    sector: null,
    input_payload: {
      source: 'web',
      public_analysis: !authUser,
      company
    },
    started_at: new Date().toISOString()
  })

  const cached = await getCachedAudit(supabase, company)
  if (cached && !isLowQualityCachedAudit(cached)) {
    let auditId = cached.id

    if (authUser?.id) {
      const savedFromCache = await saveAudit(supabase, {
        company: cached.company,
        sector: cached.sector,
        score: cached.score,
        frentes: cached.frentes || {},
        voz_usuario: cached.voz_usuario,
        gap_principal: cached.gap_principal,
        pasos: Array.isArray(cached.pasos) ? cached.pasos : []
      }, authUser.id)

      if (savedFromCache?.id) auditId = savedFromCache.id
    }

    await updateAnalysisRequest(supabase, analysisRequest?.id, {
      status: 'completed',
      result_audit_id: auditId,
      sector: cached.sector || null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })

    return res.status(200).json({ ...cached, audit_id: auditId, from_cache: true })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    const fallback = buildFallbackAudit(company, publicSignals, 'ANTHROPIC_API_KEY no configurada')
    const savedFallback = await saveAudit(supabase, fallback, authUser?.id || null)

    await updateAnalysisRequest(supabase, analysisRequest?.id, {
      status: 'completed',
      result_audit_id: savedFallback?.id || null,
      sector: fallback.sector,
      error_message: 'Se devolvió fallback por falta de configuración de Anthropic',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })

    console.error('[BALANCE360] ANTHROPIC_API_KEY no configurada, devolviendo fallback')
    return res.status(200).json({
      ...fallback,
      audit_id: savedFallback?.id || null,
      from_cache: false,
      degraded: true
    })
  }

  try {
    if (!publicSignals.existenceLikely) {
      const fallback = buildFallbackAudit(company, publicSignals, 'Sin evidencia pública suficiente')
      const savedFallback = await saveAudit(supabase, fallback, authUser?.id || null)

      await updateAnalysisRequest(supabase, analysisRequest?.id, {
        status: 'completed',
        result_audit_id: savedFallback?.id || null,
        sector: fallback.sector,
        error_message: 'Respuesta preliminar por falta de evidencia pública',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })

      return res.status(200).json({
        ...fallback,
        audit_id: savedFallback?.id || null,
        from_cache: false,
        degraded: true
      })
    }

    const normalized = await requestAnthropicAnalysis(apiKey, company, publicSignals)
    const savedAudit = await saveAudit(supabase, normalized, authUser?.id || null)

    await updateAnalysisRequest(supabase, analysisRequest?.id, {
      status: 'completed',
      result_audit_id: savedAudit?.id || null,
      sector: normalized.sector,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })

    return res.status(200).json({
      ...normalized,
      audit_id: savedAudit?.id || null,
      from_cache: false
    })
  } catch (error) {
    const fallback = buildFallbackAudit(company, publicSignals, error.message)
    const savedFallback = await saveAudit(supabase, fallback, authUser?.id || null)

    await updateAnalysisRequest(supabase, analysisRequest?.id, {
      status: 'completed',
      result_audit_id: savedFallback?.id || null,
      sector: fallback.sector,
      error_message: String(error.message || error).slice(0, 500),
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })

    console.error('[BALANCE360] Error en análisis enriquecido, devolviendo fallback:', error.message)
    return res.status(200).json({
      ...fallback,
      audit_id: savedFallback?.id || null,
      from_cache: false,
      degraded: true
    })
  }
}

export default async function handler(req, res) {
  try {
    return await handleRequest(req, res)
  } catch (error) {
    console.error('[BALANCE360] Fatal handler error:', error?.stack || error?.message || error)

    try {
      return res.status(500).json({
        error: 'Error interno del servidor',
        fatal: true,
        detail: process.env.NODE_ENV === 'development'
          ? String(error?.message || error)
          : 'fatal_handler_error'
      })
    } catch {
      return res.end('Internal Server Error')
    }
  }
}
