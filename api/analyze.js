const { createClient } = require('@supabase/supabase-js')

const fetch = global.fetch || require('node-fetch')

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

function buildSystemPrompt() {
  return [
    'Eres BALANCE360, un analista senior de inteligencia competitiva digital para grandes empresas de Latinoamérica.',
    'Debes responder solo con JSON válido, sin markdown, sin comentarios y sin texto adicional.',
    'Evalúa una empresa en seis frentes: app, web, rrss, reviews, google_business y organic_mentions.',
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
    'Mantén el lenguaje ejecutivo, concreto y útil para product managers, directores digitales y CMOs.'
  ].join('\n')
}

function buildFallbackAudit(company, details = '') {
  const note = details ? ` Contexto técnico: ${details}` : ''
  const hallazgoBase = `${company} tiene presencia digital detectable, pero el análisis automatizado completo no estuvo disponible.${note}`.trim()

  return {
    company,
    sector: 'General',
    score: 58,
    voz_usuario: `BALANCE360 generó un resultado de contingencia para ${company} mientras se estabiliza el análisis enriquecido.`,
    gap_principal: `Hace falta consolidar señales comparables de ${company} frente a sus competidores para obtener un score más preciso.`,
    pasos: [
      `Inicializando auditoría de ${company}`,
      'Intentando consulta del motor de análisis',
      'Aplicando respuesta de contingencia para no interrumpir la experiencia'
    ],
    frentes: {
      app: {
        label: 'App móvil',
        score: 55,
        hallazgos: [hallazgoBase],
        oportunidades: ['Validar rating, volumen de reseñas y desempeño funcional en stores.']
      },
      web: {
        label: 'Web',
        score: 62,
        hallazgos: ['La experiencia web requiere una evaluación detallada de UX, velocidad y propuesta de valor.'],
        oportunidades: ['Medir claridad de navegación, performance y conversión por flujo principal.']
      },
      rrss: {
        label: 'Redes sociales',
        score: 57,
        hallazgos: ['La presencia en redes existe, pero falta lectura consolidada de engagement y consistencia de marca.'],
        oportunidades: ['Comparar frecuencia, tono y respuesta a usuarios frente a competidores directos.']
      },
      reviews: {
        label: 'Reviews',
        score: 54,
        hallazgos: ['Se requiere síntesis cualitativa de quejas y elogios para detectar patrones accionables.'],
        oportunidades: ['Agrupar fricciones repetidas por producto, soporte, pagos y experiencia.']
      },
      google_business: {
        label: 'Google Business',
        score: 60,
        hallazgos: ['La huella local necesita revisión de reputación, reseñas recientes y señales de confianza.'],
        oportunidades: ['Auditar respuesta a reseñas, consistencia de ficha y volumen comparativo.']
      },
      organic_mentions: {
        label: 'Menciones orgánicas',
        score: 59,
        hallazgos: ['Hace falta consolidar visibilidad orgánica y narrativa de marca en resultados abiertos.'],
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

async function requestAnthropicAnalysis(apiKey, company) {
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
      system: buildSystemPrompt(),
      messages: [
        {
          role: 'user',
          content: `Genera un análisis ejecutivo de ${company} como producto digital para BALANCE360.`
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

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || ''
  const headers = corsHeaders(origin)

  if (req.method === 'OPTIONS') return res.status(204).set(headers).end()
  if (req.method !== 'POST') return res.status(405).set(headers).json({ error: 'Method not allowed' })

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown'
  const { allowed, remaining } = getRateLimit(ip)

  if (!allowed) {
    return res
      .status(429)
      .set({ ...headers, 'Retry-After': '60' })
      .json({ error: 'Demasiadas solicitudes. Intenta en 60 segundos.' })
  }

  res.setHeader('X-RateLimit-Remaining', remaining)

  let body
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  } catch {
    return res.status(400).set(headers).json({ error: 'Body inválido' })
  }

  const company = sanitizeInput(body?.company)
  const workspaceId = sanitizeUuid(body?.workspaceId)
  const companyId = sanitizeUuid(body?.companyId)
  const requestType = normalizeText(body?.requestType, 'single_audit')

  if (!company) {
    return res.status(400).set(headers).json({ error: 'Nombre de empresa inválido.' })
  }

  const supabase = getSupabaseClient()
  const authUser = await getAuthenticatedUser(supabase, req.headers.authorization || '')
  const profile = authUser ? await getUserProfile(supabase, authUser.id) : null

  if (
    profile &&
    profile.queries_used >= profile.queries_limit &&
    requestType !== 'onboarding_audit'
  ) {
    return res.status(403).set(headers).json({
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
  if (cached) {
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

    return res.status(200).set(headers).json({ ...cached, audit_id: auditId, from_cache: true })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    const fallback = buildFallbackAudit(company, 'ANTHROPIC_API_KEY no configurada')
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
    return res.status(200).set(headers).json({
      ...fallback,
      audit_id: savedFallback?.id || null,
      from_cache: false,
      degraded: true
    })
  }

  try {
    const normalized = await requestAnthropicAnalysis(apiKey, company)
    const savedAudit = await saveAudit(supabase, normalized, authUser?.id || null)

    await updateAnalysisRequest(supabase, analysisRequest?.id, {
      status: 'completed',
      result_audit_id: savedAudit?.id || null,
      sector: normalized.sector,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })

    return res.status(200).set(headers).json({
      ...normalized,
      audit_id: savedAudit?.id || null,
      from_cache: false
    })
  } catch (error) {
    const fallback = buildFallbackAudit(company, error.message)
    const savedFallback = await saveAudit(supabase, fallback, authUser?.id || null)

    await updateAnalysisRequest(supabase, analysisRequest?.id, {
      status: 'completed',
      result_audit_id: savedFallback?.id || null,
      sector: fallback.sector,
      error_message: error.message.slice(0, 500),
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })

    console.error('[BALANCE360] Error en análisis enriquecido, devolviendo fallback:', error.message)
    return res.status(200).set(headers).json({
      ...fallback,
      audit_id: savedFallback?.id || null,
      from_cache: false,
      degraded: true
    })
  }
}
