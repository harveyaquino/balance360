import { createClient } from '@supabase/supabase-js'
import { buildSignalsSummary, collectPublicSignals } from './lib/sources.js'

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''
const MAX_INPUT_LENGTH = 120
const RATE_LIMIT_WINDOW = 60_000
const RATE_LIMIT_MAX = 10
const CACHE_TTL_DAYS = 7
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest'
const ANTHROPIC_FALLBACK_MODELS = (process.env.ANTHROPIC_MODEL_FALLBACKS || '')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean)
const DEFAULT_MARKET_COUNTRY = process.env.DEFAULT_MARKET_COUNTRY || 'Peru'

const COUNTRY_HINTS = [
  { canonical: 'Peru', patterns: [/peru/i, /\bpe\b/i] },
  { canonical: 'Chile', patterns: [/chile/i, /\bcl\b/i] },
  { canonical: 'Colombia', patterns: [/colombia/i, /\bco\b/i] },
  { canonical: 'Mexico', patterns: [/mexico/i, /\bmx\b/i] },
  { canonical: 'Argentina', patterns: [/argentina/i, /\bar\b/i] },
  { canonical: 'Ecuador', patterns: [/ecuador/i, /\bec\b/i] },
  { canonical: 'Uruguay', patterns: [/uruguay/i, /\buy\b/i] },
  { canonical: 'Paraguay', patterns: [/paraguay/i, /\bpy\b/i] },
  { canonical: 'Bolivia', patterns: [/bolivia/i, /\bbo\b/i] },
  { canonical: 'Spain', patterns: [/espaÃ±a/i, /espana/i, /\bes\b/i, /spain/i] }
]

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

function detectCountryFromText(value) {
  const text = normalizeText(value).toLowerCase()
  if (!text) return null
  for (const hint of COUNTRY_HINTS) {
    if (hint.patterns.some((pattern) => pattern.test(text))) return hint.canonical
  }
  return null
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

const MOJIBAKE_PATTERN = /Ã.|Â.|â.|ðŸ|ï¿½|�/

function repairMojibake(value) {
  if (typeof value !== 'string') return ''
  let next = value

  for (let index = 0; index < 2; index += 1) {
    if (!MOJIBAKE_PATTERN.test(next)) break
    try {
      const decoded = Buffer.from(next, 'latin1').toString('utf8')
      if (!decoded || decoded === next) break
      next = decoded
    } catch {
      break
    }
  }

  return next
}

function normalizeDeepStrings(value) {
  if (typeof value === 'string') return repairMojibake(value).trim()
  if (Array.isArray(value)) return value.map((item) => normalizeDeepStrings(item))
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, normalizeDeepStrings(nested)])
  )
}

function normalizeText(value, fallback = '') {
  if (typeof value !== 'string') return repairMojibake(String(fallback || '')).trim()
  return repairMojibake(value).trim()
}

function normalizeList(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => normalizeText(item)).filter(Boolean).slice(0, 6)
}

function normalizeCompetitors(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => ({
      name: normalizeText(item?.name),
      score: normalizeScore(item?.score, 0),
      fortaleza: normalizeText(item?.fortaleza),
      brecha: normalizeText(item?.brecha)
    }))
    .filter((item) => item.name)
    .slice(0, 2)
}

function normalizeBenchmark(value) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    posicion_relativa: normalizeText(source.posicion_relativa),
    competidores: normalizeCompetitors(source.competidores),
    brechas_clave: normalizeList(source.brechas_clave).slice(0, 4)
  }
}

function normalizeFrontBenchmark(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => ({
      frente: normalizeText(item?.frente),
      label: normalizeText(item?.label),
      score_objetivo: normalizeScore(item?.score_objetivo, 0),
      score_competencia: normalizeScore(item?.score_competencia, 0),
      delta: Number.isFinite(Number(item?.delta)) ? Math.round(Number(item.delta)) : 0
    }))
    .filter((item) => item.frente && item.label)
    .slice(0, 6)
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
    mercado: normalizeText(source.mercado, DEFAULT_MARKET_COUNTRY),
    score: normalizeScore(source.score, 0),
    resumen_ejecutivo: normalizeText(source.resumen_ejecutivo),
    voz_usuario: normalizeText(source.voz_usuario),
    gap_principal: normalizeText(source.gap_principal),
    riesgos_clave: normalizeList(source.riesgos_clave).slice(0, 3),
    palancas_crecimiento: normalizeList(source.palancas_crecimiento).slice(0, 3),
    quick_wins_30_dias: normalizeList(source.quick_wins_30_dias).slice(0, 3),
    benchmark_competitivo: normalizeBenchmark(source.benchmark_competitivo),
    benchmark_por_frente: normalizeFrontBenchmark(source.benchmark_por_frente),
    pasos: normalizeList(source.pasos),
    frentes: {
      app: normalizeFront(pickFront(frentes, ['app', 'mobile_app', 'app_movil']), 'App mÃ³vil'),
      web: normalizeFront(pickFront(frentes, ['web', 'website', 'sitio_web']), 'Web'),
      rrss: normalizeFront(pickFront(frentes, ['rrss', 'redes_sociales', 'social', 'social_media']), 'Redes sociales'),
      reviews: normalizeFront(pickFront(frentes, ['reviews', 'ratings']), 'Reviews'),
      google_business: normalizeFront(
        pickFront(frentes, ['google_business', 'google', 'google_maps', 'google_business_profile']),
        'Google Business'
      ),
      organic_mentions: normalizeFront(
        pickFront(frentes, ['organic_mentions', 'organic', 'seo', 'menciones_organicas']),
        'Menciones orgÃ¡nicas'
      )
    }
  }
}

function sanitizeAuditPayload(raw, companyFallback = '') {
  const normalized = normalizeAuditResult(raw, companyFallback || normalizeText(raw?.company, 'Empresa'))
  return normalizeDeepStrings(normalized)
}

function pushUnique(list, value) {
  const text = normalizeText(value)
  if (!text) return list
  if (list.some((item) => normalizeText(item).toLowerCase() === text.toLowerCase())) return list
  return [...list, text]
}

function reconcileAuditWithSignals(audit, signals) {
  if (!audit || !signals) return audit

  const merged = {
    ...audit,
    frentes: {
      app: { ...(audit.frentes?.app || {}) },
      web: { ...(audit.frentes?.web || {}) },
      rrss: { ...(audit.frentes?.rrss || {}) },
      reviews: { ...(audit.frentes?.reviews || {}) },
      google_business: { ...(audit.frentes?.google_business || {}) },
      organic_mentions: { ...(audit.frentes?.organic_mentions || {}) }
    }
  }

  if (signals.web?.found) {
    merged.frentes.web.score = Math.max(merged.frentes.web.score || 0, 55)
    merged.frentes.web.hallazgos = pushUnique(
      Array.isArray(merged.frentes.web.hallazgos) ? merged.frentes.web.hallazgos : [],
      `Detectamos sitio o dominio asociado: ${signals.web.url || 'sin URL visible'}.`
    )
  }

  if (signals.google_business?.found && signals.google_business?.place) {
    merged.frentes.google_business.score = Math.max(merged.frentes.google_business.score || 0, 55)
    merged.frentes.google_business.hallazgos = pushUnique(
      Array.isArray(merged.frentes.google_business.hallazgos) ? merged.frentes.google_business.hallazgos : [],
      `Se detectÃ³ ficha de Maps: ${signals.google_business.place.name || 'Google Maps'}${signals.google_business.place.rating ? ` (rating ${signals.google_business.place.rating})` : ''}.`
    )
  }

  if (signals.app?.app_store || signals.app?.play_store) {
    merged.frentes.app.score = Math.max(merged.frentes.app.score || 0, 55)
    const appHint = signals.app?.play_store?.name || signals.app?.app_store?.name || 'app pÃºblica detectada'
    merged.frentes.app.hallazgos = pushUnique(
      Array.isArray(merged.frentes.app.hallazgos) ? merged.frentes.app.hallazgos : [],
      `Detectamos seÃ±al de app: ${appHint}.`
    )
  }

  if (signals.reviews?.found) {
    merged.frentes.reviews.score = Math.max(merged.frentes.reviews.score || 0, 48)
  }

  if ((signals.organic_mentions?.mentionsCount || 0) > 0) {
    merged.frentes.organic_mentions.score = Math.max(merged.frentes.organic_mentions.score || 0, 28)
  }

  const detectedCount = [
    Boolean(signals.web?.found),
    Boolean(signals.google_business?.found),
    Boolean(signals.app?.app_store || signals.app?.play_store),
    Boolean((signals.organic_mentions?.mentionsCount || 0) > 0),
    Boolean((signals.rrss?.count || 0) > 0)
  ].filter(Boolean).length

  if (detectedCount >= 3) {
    merged.score = Math.max(merged.score || 0, 45)
  } else if (detectedCount >= 2) {
    merged.score = Math.max(merged.score || 0, 36)
  }

  return merged
}

function extractTextBlocks(apiData) {
  return (apiData.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('No se encontrÃ³ JSON en la respuesta del agente')
  return JSON.parse(match[0])
}

function buildSystemPrompt(signals, context = {}) {
  const marketCountry = normalizeText(context.marketCountry, DEFAULT_MARKET_COUNTRY)
  const competitors = Array.isArray(context.competitors) ? context.competitors : []
  const competitorsLine = competitors.length
    ? `Competidores base obligatorios: ${competitors.map((item) => item.name).filter(Boolean).join(', ')}.`
    : 'Incluye exactamente 2 competidores directos relevantes por mercado/sector, aunque sean inferidos con prudencia.'

  return [
    'Eres BALANCE360, un analista senior de inteligencia competitiva digital para grandes empresas de LatinoamÃ©rica.',
    'Debes responder solo con JSON vÃ¡lido, sin markdown, sin comentarios y sin texto adicional.',
    `Mercado objetivo prioritario: ${marketCountry}.`,
    'Si la marca existe en varios paÃ­ses, prioriza estrictamente el mercado objetivo.',
    'EvalÃºa una empresa en seis frentes: app, web, rrss, reviews, google_business y organic_mentions.',
    'Usa Ãºnicamente la evidencia entregada. No inventes presencia digital si las seÃ±ales no aparecen.',
    'Si la evidencia es dÃ©bil o contradictoria, dilo explÃ­citamente en hallazgos y baja el score.',
    'Cada frente debe incluir score (0 a 100), hallazgos (array) y oportunidades (array).',
    'La respuesta JSON debe usar exactamente esta estructura:',
    '{',
    '  "company": "string",',
    '  "sector": "string",',
    '  "mercado": "string",',
    '  "score": 0,',
    '  "resumen_ejecutivo": "string",',
    '  "voz_usuario": "string",',
    '  "gap_principal": "string",',
    '  "riesgos_clave": ["string"],',
    '  "palancas_crecimiento": ["string"],',
    '  "quick_wins_30_dias": ["string"],',
    '  "benchmark_competitivo": {',
    '    "posicion_relativa": "string",',
    '    "competidores": [',
    '      { "name": "string", "score": 0, "fortaleza": "string", "brecha": "string" },',
    '      { "name": "string", "score": 0, "fortaleza": "string", "brecha": "string" }',
    '    ],',
    '    "brechas_clave": ["string"]',
    '  },',
    '  "benchmark_por_frente": [',
    '    { "frente": "app", "label": "App", "score_objetivo": 0, "score_competencia": 0, "delta": 0 }',
    '  ],',
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
    competitorsLine,
    'No uses placeholders: evita "competidor 1/2", usa nombres reales de marcas.',
    'Si no tienes certeza, infiere con prudencia y deja constancia en hallazgos u oportunidades.',
    'MantÃ©n el lenguaje ejecutivo, concreto y Ãºtil para product managers, directores digitales y CMOs.',
    'EVIDENCIA DISPONIBLE:',
    buildSignalsSummary(signals)
  ].join('\n')
}

function inferFallbackCompetitors(company) {
  const key = String(company || '').toLowerCase()

  if (/scotiabank|bbva|interbank|bcp|banco|banbif/.test(key)) {
    return [
      { name: 'BCP', score: 66, fortaleza: 'Mayor alcance digital y recordaciÃ³n de marca en banca retail.', brecha: 'Velocidad de iteraciÃ³n en experiencia mÃ³vil y comunicaciÃ³n de beneficios.' },
      { name: 'BBVA', score: 64, fortaleza: 'Ecosistema de app y web con mejor continuidad de flujos.', brecha: 'Consistencia de reputaciÃ³n y respuesta en canales pÃºblicos.' }
    ]
  }

  if (/claro|movistar|entel|wom|bitel|telco|telecom/.test(key)) {
    return [
      { name: 'Movistar', score: 62, fortaleza: 'Presencia orgÃ¡nica y social mÃ¡s estable por volumen de marca.', brecha: 'Calidad percibida en soporte digital y tiempos de respuesta.' },
      { name: 'Entel', score: 60, fortaleza: 'Mensaje comercial mÃ¡s consistente en campaÃ±as digitales.', brecha: 'Claridad de propuesta digital por segmento y autoservicio.' }
    ]
  }

  return [
    { name: 'Competidor lÃ­der del sector', score: 63, fortaleza: 'Mayor madurez de marca y distribuciÃ³n digital.', brecha: 'Consistencia de experiencia y conversiÃ³n en puntos crÃ­ticos.' },
    { name: 'Competidor retador', score: 58, fortaleza: 'EjecuciÃ³n mÃ¡s Ã¡gil en contenido y performance digital.', brecha: 'DiferenciaciÃ³n funcional visible en canales pÃºblicos.' }
  ]
}

function buildFallbackAudit(company, signals, details = '', context = {}) {
  const toHostname = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return null
    }
  }

  const appStore = signals?.app?.app_store || null
  const playStore = signals?.app?.play_store || null
  const mapsPlace = signals?.google_business?.place || null
  const socialProfiles = Array.isArray(signals?.rrss?.profiles) ? signals.rrss.profiles : []
  const organicTopLinks = Array.isArray(signals?.organic_mentions?.topLinks) ? signals.organic_mentions.topLinks : []
  const rootCause = 'Motor enriquecido no disponible temporalmente; usando lectura de contingencia basada en seÃ±ales pÃºblicas.'

  const detectedSignalsCount = [
    Boolean(signals?.web?.found),
    Boolean(signals?.google_business?.found),
    Boolean(appStore || playStore),
    Boolean((signals?.organic_mentions?.mentionsCount || 0) > 0),
    Boolean(socialProfiles.length > 0)
  ].filter(Boolean).length

  let baseScore = signals?.confidenceScore
    ? Math.max(24, Math.min(84, Math.round(signals.confidenceScore * 0.96)))
    : 34

  if (detectedSignalsCount >= 4) baseScore = Math.max(baseScore, 56)
  else if (detectedSignalsCount >= 3) baseScore = Math.max(baseScore, 48)
  else if (detectedSignalsCount >= 2) baseScore = Math.max(baseScore, 40)

  const webHallazgos = []
  if (signals?.web?.found) {
    const host = toHostname(signals?.web?.url) || 'dominio detectado'
    webHallazgos.push(`Detectamos un dominio asociado a ${company}: ${host}.`)
    if (signals?.web?.title) webHallazgos.push(`Titulo visible: "${String(signals.web.title).slice(0, 90)}".`)
    if (signals?.web?.description) webHallazgos.push(`Descripcion publica: "${String(signals.web.description).slice(0, 120)}".`)
  } else if (mapsPlace?.websiteUrl) {
    const host = toHostname(mapsPlace.websiteUrl) || mapsPlace.websiteUrl
    webHallazgos.push(`No hubo web directa, pero Google Maps referencia sitio: ${host}.`)
  } else {
    webHallazgos.push('No encontramos una web oficial clara en esta pasada publica.')
  }
  webHallazgos.push(rootCause)

  const appHallazgos = []
  if (appStore) {
    appHallazgos.push(`App Store: "${appStore.name || 'app detectada'}"${appStore.seller ? ` por ${appStore.seller}` : ''}.`)
    if (appStore.averageRating || appStore.ratingCount) {
      appHallazgos.push(`Senales de rating iOS: ${appStore.averageRating || 's/d'} con ${appStore.ratingCount || 0} resenas.`)
    }
  }
  if (playStore) {
    appHallazgos.push(`Google Play: "${playStore.name || 'app detectada'}"${playStore.developer ? ` por ${playStore.developer}` : ''}.`)
    if (playStore.rating || playStore.reviews) {
      appHallazgos.push(`Senales de rating Android: ${playStore.rating || 's/d'} con ${playStore.reviews || 0} reviews.`)
    }
  }
  if (!appHallazgos.length) {
    appHallazgos.push(`No encontramos evidencia suficiente de app publica para ${company}.`)
  }
  appHallazgos.push(rootCause)

  const rrssHallazgos = []
  if (socialProfiles.length) {
    const sample = socialProfiles
      .slice(0, 3)
      .map((profile) => toHostname(profile.href) || profile.href || profile.title)
      .filter(Boolean)
      .join(', ')
    rrssHallazgos.push(`Detectamos ${socialProfiles.length} perfiles o senales sociales relevantes.`)
    if (sample) rrssHallazgos.push(`Perfiles visibles: ${sample}.`)
  } else {
    rrssHallazgos.push('No encontramos perfiles sociales claros en esta pasada publica.')
  }
  rrssHallazgos.push(rootCause)

  const reviewsHallazgos = []
  const iosCount = appStore?.ratingCount || 0
  const playCount = playStore?.reviews || 0
  const mapsCount = mapsPlace?.ratingCount || 0
  if (iosCount + playCount + mapsCount > 0) {
    reviewsHallazgos.push(
      `Hay senales de resenas publicas (iOS: ${iosCount}, Android: ${playCount}, Maps: ${mapsCount}).`
    )
    if (mapsPlace?.rating) reviewsHallazgos.push(`Rating visible en Maps: ${mapsPlace.rating}.`)
  } else {
    reviewsHallazgos.push('No encontramos suficientes resenas publicas verificables para sintetizar voz del usuario.')
  }
  reviewsHallazgos.push(rootCause)

  const gbHallazgos = []
  if (signals?.google_business?.found && mapsPlace) {
    gbHallazgos.push(`Detectamos ficha de Maps: ${mapsPlace.name || company}.`)
    if (mapsPlace.address) gbHallazgos.push(`Direccion visible: ${mapsPlace.address}.`)
    if (mapsPlace.rating || mapsPlace.ratingCount) {
      gbHallazgos.push(`Rating local: ${mapsPlace.rating || 's/d'} con ${mapsPlace.ratingCount || 0} resenas.`)
    }
  } else {
    gbHallazgos.push('No encontramos una ficha clara de Google Business en esta consulta publica.')
  }
  gbHallazgos.push(rootCause)

  const organicHallazgos = []
  const mentions = signals?.organic_mentions?.mentionsCount || 0
  if (mentions > 0) {
    organicHallazgos.push(`Detectamos ${mentions} resultados organicos visibles para ${company}.`)
    const topDomains = organicTopLinks
      .slice(0, 3)
      .map((item) => toHostname(item.href) || item.href)
      .filter(Boolean)
      .join(', ')
    if (topDomains) organicHallazgos.push(`Fuentes organicas destacadas: ${topDomains}.`)
  } else {
    organicHallazgos.push(`No encontramos suficientes menciones organicas confiables para ${company}.`)
  }
  organicHallazgos.push(rootCause)
  const contextCompetitors = Array.isArray(context?.competitors) ? context.competitors : []
  const fallbackCompetitors = inferFallbackCompetitors(company)
  const competitors = (contextCompetitors.length ? contextCompetitors : fallbackCompetitors)
    .map((item) => ({
      name: normalizeText(item?.name),
      score: normalizeScore(item?.score || item?.audit?.score || 0, 0),
      fortaleza: normalizeText(item?.fortaleza, 'Fortaleza competitiva visible en presencia digital.'),
      brecha: normalizeText(item?.brecha, 'Brecha abierta en consistencia de experiencia y reputacion.')
    }))
    .filter((item) => item.name)
    .slice(0, 2)
  const competitorAverage = competitors.length
    ? Math.round(competitors.reduce((acc, item) => acc + (Number(item.score) || 0), 0) / competitors.length)
    : 0

  return {
    company,
    sector: 'General',
    mercado: normalizeText(context?.marketCountry, DEFAULT_MARKET_COUNTRY),
    score: baseScore,
    resumen_ejecutivo: `${company} muestra seÃ±ales digitales visibles pero todavÃ­a fragmentadas. La prioridad es pasar de detecciÃ³n de presencia a ejecuciÃ³n consistente en adquisiciÃ³n, experiencia y reputaciÃ³n.`,
    voz_usuario: signals?.existenceLikely
      ? `BALANCE360 detecto evidencia publica inicial de ${company}. Esta lectura usa senales observables y debe tomarse como analisis operativo de contingencia.`
      : `BALANCE360 detecto evidencia publica limitada para ${company}. Mostramos una lectura de contingencia con trazas concretas de lo encontrado.`,
    gap_principal: 'Falta consolidar fuentes verificadas por frente y benchmarking competitivo para reemplazar este modo de contingencia por una lectura enriquecida completa.',
    riesgos_clave: [
      'Perder share of search y demanda incremental por baja consistencia de presencia cross-canal.',
      'Deterioro de confianza por seÃ±ales de reputaciÃ³n no gestionadas de forma continua.',
      'Decisiones de producto y marketing con evidencia incompleta frente a competidores.'
    ],
    palancas_crecimiento: [
      'Orquestar narrativa Ãºnica entre web, app y canales sociales para mejorar conversiÃ³n.',
      'Priorizar gestiÃ³n de reviews y respuesta pÃºblica para mover percepciÃ³n de servicio.',
      'Optimizar rutas de autoservicio y onboarding en frentes con mayor fricciÃ³n visible.'
    ],
    quick_wins_30_dias: [
      'Definir tablero semanal de seÃ±ales por frente con responsables y umbrales.',
      'Corregir 3 fricciones de alto impacto en web/app detectadas en hallazgos.',
      'Implementar protocolo de respuesta pÃºblica en reviews y redes con SLA operativo.'
    ],
    benchmark_competitivo: {
      posicion_relativa: competitorAverage
        ? `${company} se ubica ${baseScore >= competitorAverage ? 'en paridad relativa' : 'por debajo'} frente al promedio de 2 competidores de referencia (${competitorAverage}/100).`
        : `${company} requiere benchmark estructurado para definir su posiciÃ³n relativa.`,
      competidores: competitors,
      brechas_clave: [
        'Menor consistencia de seÃ±al pÃºblica entre frentes crÃ­ticos.',
        'ConversiÃ³n y experiencia digital con baja evidencia de optimizaciÃ³n continua.',
        'GestiÃ³n reputacional menos sistemÃ¡tica que referentes del sector.'
      ]
    },
    benchmark_por_frente: computeFrontBenchmark(
      {
        app: { score: appStore || playStore ? 54 : 18 },
        web: { score: signals?.web?.found ? 62 : 24 },
        rrss: { score: socialProfiles.length ? Math.min(72, 30 + socialProfiles.length * 11) : 20 },
        reviews: { score: signals?.reviews?.found ? 52 : 18 },
        google_business: { score: signals?.google_business?.found ? 58 : 20 },
        organic_mentions: { score: mentions ? Math.min(74, 24 + mentions * 6) : 16 }
      },
      (contextCompetitors.length ? contextCompetitors : []).filter((item) => item?.audit)
    ),
    pasos: [
      `Inicializando auditoria de ${company}`,
      'Recolectando senales publicas del producto',
      'Construyendo lectura ejecutiva de contingencia con evidencia observable'
    ],
    frentes: {
      app: {
        label: 'App movil',
        score: appStore || playStore ? 54 : 18,
        hallazgos: appHallazgos.slice(0, 4),
        oportunidades: ['Validar presencia real en App Store y Google Play, rating, volumen de resenas y desempeno funcional.']
      },
      web: {
        label: 'Web',
        score: signals?.web?.found ? 62 : 24,
        hallazgos: webHallazgos.slice(0, 4),
        oportunidades: ['Validar dominio oficial, claridad de navegacion, performance y conversion por flujo principal.']
      },
      rrss: {
        label: 'Redes sociales',
        score: socialProfiles.length ? Math.min(72, 30 + socialProfiles.length * 11) : 20,
        hallazgos: rrssHallazgos.slice(0, 4),
        oportunidades: ['Comparar frecuencia, tono y tiempo de respuesta a usuarios frente a competidores directos.']
      },
      reviews: {
        label: 'Reviews',
        score: signals?.reviews?.found ? 52 : 18,
        hallazgos: reviewsHallazgos.slice(0, 4),
        oportunidades: ['Agrupar fricciones repetidas por producto, soporte, pagos y experiencia cuando conectemos mas fuentes de reviews.']
      },
      google_business: {
        label: 'Google Business',
        score: signals?.google_business?.found ? 58 : 20,
        hallazgos: gbHallazgos.slice(0, 4),
        oportunidades: ['Auditar reputacion local, respuesta a resenas y consistencia de ficha.']
      },
      organic_mentions: {
        label: 'Menciones organicas',
        score: mentions ? Math.min(74, 24 + mentions * 6) : 16,
        hallazgos: organicHallazgos.slice(0, 4),
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

async function getCompanyRecord(supabase, workspaceId, companyId, companyName) {
  if (!supabase) return null

  if (companyId) {
    const { data } = await supabase
      .from('companies')
      .select('*')
      .eq('id', companyId)
      .maybeSingle()
    if (data) return data
  }

  if (workspaceId) {
    const { data } = await supabase
      .from('companies')
      .select('*')
      .eq('workspace_id', workspaceId)
      .ilike('name', companyName)
      .limit(1)
      .maybeSingle()
    if (data) return data
  }

  return null
}

async function getCompanyCompetitors(supabase, workspaceId, companyId) {
  if (!supabase || !workspaceId || !companyId) return []
  const { data, error } = await supabase
    .from('company_competitors')
    .select('competitor_name, competitor_slug, confidence')
    .eq('workspace_id', workspaceId)
    .eq('company_id', companyId)
    .order('confidence', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(2)

  if (error) return []
  return Array.isArray(data) ? data : []
}

async function getCompetitorLatestAudit(supabase, competitorSlug) {
  if (!supabase || !competitorSlug) return null
  const { data, error } = await supabase
    .from('audits')
    .select('company, company_slug, score, frentes, created_at')
    .eq('company_slug', competitorSlug)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return null
  return data || null
}

async function buildAnalysisContext({
  supabase,
  workspaceId,
  companyId,
  companyName,
  authUserId
}) {
  const companyRecord = await getCompanyRecord(supabase, workspaceId, companyId, companyName)
  let marketCountry = detectCountryFromText(companyName) || normalizeText(companyRecord?.country)

  if (!marketCountry && supabase && workspaceId) {
    const { data } = await supabase
      .from('workspaces')
      .select('country')
      .eq('id', workspaceId)
      .maybeSingle()
    marketCountry = normalizeText(data?.country)
  }

  const fromTable = await getCompanyCompetitors(supabase, workspaceId, companyId)
  const baseCompetitors = fromTable.map((item) => ({
    name: normalizeText(item.competitor_name),
    slug: normalizeText(item.competitor_slug)
  })).filter((item) => item.name)

  if (baseCompetitors.length < 2 && supabase && authUserId) {
    const { data } = await supabase
      .from('onboarding_states')
      .select('primary_competitor')
      .eq('user_id', authUserId)
      .maybeSingle()

    const onboardingCompetitor = normalizeText(data?.primary_competitor)
    if (onboardingCompetitor && !baseCompetitors.some((item) => item.name.toLowerCase() === onboardingCompetitor.toLowerCase())) {
      baseCompetitors.push({ name: onboardingCompetitor, slug: slugify(onboardingCompetitor) })
    }
  }

  if (baseCompetitors.length < 2) {
    for (const fallback of inferFallbackCompetitors(companyName)) {
      if (baseCompetitors.length >= 2) break
      if (!baseCompetitors.some((item) => item.name.toLowerCase() === fallback.name.toLowerCase())) {
        baseCompetitors.push({ name: fallback.name, slug: slugify(fallback.name) })
      }
    }
  }

  const competitors = []
  for (const item of baseCompetitors.slice(0, 2)) {
    const audit = await getCompetitorLatestAudit(supabase, item.slug)
    competitors.push({ ...item, audit })
  }

  if (!marketCountry) marketCountry = DEFAULT_MARKET_COUNTRY

  return {
    marketCountry,
    competitors
  }
}

function normalizeFrenteScore(front) {
  const score = Number(front?.score)
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null
}

function computeFrontBenchmark(targetFrentes, competitorsWithAudits) {
  const frontMap = {
    app: 'App',
    web: 'Web',
    rrss: 'RRSS',
    reviews: 'Reviews',
    google_business: 'Google Business',
    organic_mentions: 'Menciones organicas'
  }

  const output = []
  for (const [key, label] of Object.entries(frontMap)) {
    const target = normalizeFrenteScore(targetFrentes?.[key])
    if (target == null) continue

    const competitorScores = competitorsWithAudits
      .map((item) => ({
        name: item.name,
        score: normalizeFrenteScore(item.audit?.frentes?.[key])
      }))
      .filter((item) => item.score != null)

    if (!competitorScores.length) continue

    const avg = Math.round(competitorScores.reduce((acc, item) => acc + item.score, 0) / competitorScores.length)
    output.push({
      frente: key,
      label,
      score_objetivo: target,
      score_competencia: avg,
      delta: target - avg
    })
  }

  return output
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
    'contexto tÃ©cnico',
    'anthropic',
    'no encontramos seÃ±ales pÃºblicas suficientes',
    'no encontramos evidencia pÃºblica suficiente'
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
  const sanitized = sanitizeAuditPayload(result, result?.company)

  const payload = {
    company: sanitized.company,
    company_slug: slugify(sanitized.company),
    sector: sanitized.sector,
    score: sanitized.score,
    frentes: sanitized.frentes,
    voz_usuario: sanitized.voz_usuario,
    gap_principal: sanitized.gap_principal,
    pasos: sanitized.pasos,
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
    console.warn('[BALANCE360] Error guardando auditorÃ­a:', error.message)
    return null
  }

  await upsertBenchmark(supabase, sanitized, data.id)
  if (userId) await incrementUserQueries(supabase, userId)

  return data
}

async function requestAnthropicAnalysis(apiKey, company, signals, context = {}) {
  const candidates = [
    ANTHROPIC_MODEL,
    ...ANTHROPIC_FALLBACK_MODELS,
    'claude-3-7-sonnet-latest',
    'claude-3-5-haiku-latest'
  ].filter((value, index, list) => value && list.indexOf(value) === index)

  let lastError = null

  for (const model of candidates) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 2500,
        system: buildSystemPrompt(signals, context),
        messages: [
          {
            role: 'user',
            content: `Genera un anÃ¡lisis ejecutivo de ${company} como producto digital para BALANCE360 usando solo la evidencia disponible.`
          }
        ]
      })
    })

    if (response.ok) {
      const apiData = await response.json()
      const fullText = extractTextBlocks(apiData)
      const parsed = extractJson(fullText)
      const normalized = normalizeAuditResult(parsed, company)
      const withFrontBenchmark = {
        ...normalized,
        benchmark_por_frente: normalized.benchmark_por_frente?.length
          ? normalized.benchmark_por_frente
          : computeFrontBenchmark(normalized.frentes, (context.competitors || []).filter((item) => item?.audit))
      }
      return withFrontBenchmark
    }

    const errText = await response.text()
    const notFoundModel = response.status === 404 && /not_found_error|model/i.test(errText)
    if (!notFoundModel) {
      throw new Error(`Anthropic ${response.status}: ${errText.slice(0, 300)}`)
    }

    lastError = `Anthropic ${response.status}: ${errText.slice(0, 300)}`
    console.warn(`[BALANCE360] Modelo Anthropic no disponible: ${model}`)
  }

  throw new Error(lastError || 'Anthropic model not available')
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
    return res.status(400).json({ error: 'Body invÃ¡lido' })
  }

  const company = sanitizeInput(body?.company)
  const workspaceId = sanitizeUuid(body?.workspaceId)
  const companyId = sanitizeUuid(body?.companyId)
  const requestType = normalizeText(body?.requestType, 'single_audit')
  const forceRefresh = body?.forceRefresh === true

  if (!company) {
    return res.status(400).json({ error: 'Nombre de empresa invÃ¡lido.' })
  }

  const supabase = getSupabaseClient()
  const authUser = await getAuthenticatedUser(supabase, req.headers.authorization || '')
  const profile = authUser ? await getUserProfile(supabase, authUser.id) : null
  const analysisContext = await buildAnalysisContext({
    supabase,
    workspaceId,
    companyId,
    companyName: company,
    authUserId: authUser?.id || null
  })
  const publicSignals = await collectPublicSignals(company, {
    marketCountry: analysisContext.marketCountry
  })

  if (
    profile &&
    profile.queries_used >= profile.queries_limit &&
    requestType !== 'onboarding_audit'
  ) {
    return res.status(403).json({
      error: 'Alcanzaste el lÃ­mite de anÃ¡lisis de tu plan actual. Haz upgrade para continuar.'
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
    competitors: (analysisContext.competitors || []).map((item) => ({
      name: item.name,
      slug: item.slug
    })),
    input_payload: {
      source: 'web',
      public_analysis: !authUser,
      company,
      market_country: analysisContext.marketCountry
    },
    started_at: new Date().toISOString()
  })

  const cached = await getCachedAudit(supabase, company)
  if (!forceRefresh && cached && !isLowQualityCachedAudit(cached)) {
    const cachedNormalized = normalizeAuditResult(cached, company)
    const cachedReconciled = reconcileAuditWithSignals(cachedNormalized, publicSignals)
    const cachedWithContext = {
      ...cachedReconciled,
      mercado: cachedReconciled.mercado || analysisContext.marketCountry,
      benchmark_por_frente: cachedReconciled.benchmark_por_frente?.length
        ? cachedReconciled.benchmark_por_frente
        : computeFrontBenchmark(cachedReconciled.frentes, (analysisContext.competitors || []).filter((item) => item?.audit)),
      benchmark_competitivo: {
        ...(cachedReconciled.benchmark_competitivo || {}),
        competidores: cachedReconciled.benchmark_competitivo?.competidores?.length
          ? cachedReconciled.benchmark_competitivo.competidores
          : (analysisContext.competitors || []).map((item) => ({
            name: item.name,
            score: normalizeScore(item.audit?.score, 0),
            fortaleza: 'Fortaleza competitiva observada en seÃ±ales publicas.',
            brecha: 'Brecha competitiva pendiente de cierre.'
          })).slice(0, 2)
      }
    }
    let auditId = cached.id

    if (authUser?.id) {
      const savedFromCache = await saveAudit(supabase, {
        company: cachedWithContext.company,
        sector: cachedWithContext.sector,
        score: cachedWithContext.score,
        frentes: cachedWithContext.frentes || {},
        voz_usuario: cachedWithContext.voz_usuario,
        gap_principal: cachedWithContext.gap_principal,
        pasos: Array.isArray(cachedWithContext.pasos) ? cachedWithContext.pasos : []
      }, authUser.id)

      if (savedFromCache?.id) auditId = savedFromCache.id
    }

    await updateAnalysisRequest(supabase, analysisRequest?.id, {
      status: 'completed',
      result_audit_id: auditId,
      sector: cachedWithContext.sector || null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })

    return res.status(200).json(normalizeDeepStrings({
      ...cached,
      ...cachedWithContext,
      audit_id: auditId,
      from_cache: true,
      signal_confidence: publicSignals.confidenceScore,
      signals_evidence: publicSignals.evidence,
      data_quality: publicSignals.existenceLikely ? 'verified_signals' : 'weak_signals'
    }))
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    const fallback = buildFallbackAudit(company, publicSignals, 'ANTHROPIC_API_KEY no configurada', analysisContext)
    const savedFallback = await saveAudit(supabase, fallback, authUser?.id || null)

    await updateAnalysisRequest(supabase, analysisRequest?.id, {
      status: 'completed',
      result_audit_id: savedFallback?.id || null,
      sector: fallback.sector,
      error_message: 'Se devolviÃ³ fallback por falta de configuraciÃ³n de Anthropic',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })

    console.error('[BALANCE360] ANTHROPIC_API_KEY no configurada, devolviendo fallback')
    return res.status(200).json(normalizeDeepStrings({
      ...fallback,
      audit_id: savedFallback?.id || null,
      from_cache: false,
      degraded: true,
      signal_confidence: publicSignals.confidenceScore,
      signals_evidence: publicSignals.evidence,
      data_quality: publicSignals.existenceLikely ? 'verified_signals' : 'weak_signals'
    }))
  }

  try {
    const normalized = await requestAnthropicAnalysis(apiKey, company, publicSignals, analysisContext)
    const reconciled = reconcileAuditWithSignals(normalized, publicSignals)
    const savedAudit = await saveAudit(supabase, reconciled, authUser?.id || null)

    await updateAnalysisRequest(supabase, analysisRequest?.id, {
      status: 'completed',
      result_audit_id: savedAudit?.id || null,
      sector: reconciled.sector,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })

    return res.status(200).json(normalizeDeepStrings({
      ...reconciled,
      audit_id: savedAudit?.id || null,
      from_cache: false,
      signal_confidence: publicSignals.confidenceScore,
      signals_evidence: publicSignals.evidence,
      data_quality: publicSignals.existenceLikely ? 'verified_signals' : 'weak_signals'
    }))
  } catch (error) {
    const fallback = buildFallbackAudit(company, publicSignals, error.message, analysisContext)
    const savedFallback = await saveAudit(supabase, fallback, authUser?.id || null)

    await updateAnalysisRequest(supabase, analysisRequest?.id, {
      status: 'completed',
      result_audit_id: savedFallback?.id || null,
      sector: fallback.sector,
      error_message: String(error.message || error).slice(0, 500),
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })

    console.error('[BALANCE360] Error en anÃ¡lisis enriquecido, devolviendo fallback:', error.message)
    return res.status(200).json(normalizeDeepStrings({
      ...fallback,
      audit_id: savedFallback?.id || null,
      from_cache: false,
      degraded: true,
      signal_confidence: publicSignals.confidenceScore,
      signals_evidence: publicSignals.evidence,
      data_quality: publicSignals.existenceLikely ? 'verified_signals' : 'weak_signals'
    }))
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

