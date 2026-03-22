// api/analyze.js — Vercel Serverless Function (CommonJS)
const { createClient } = require('@supabase/supabase-js')

// ✅ FIX: asegurar fetch en Node
const fetch = global.fetch || require('node-fetch')

const ALLOWED_ORIGIN    = process.env.ALLOWED_ORIGIN || ''
const MAX_INPUT_LENGTH  = 120
const RATE_LIMIT_WINDOW = 60_000
const RATE_LIMIT_MAX    = 10

const rateLimitMap = new Map()

function getRateLimit(ip) {
  const now   = Date.now()
  const entry = rateLimitMap.get(ip)
  if (!entry || now - entry.timestamp > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { count: 1, timestamp: now })
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 }
  }
  if (entry.count >= RATE_LIMIT_MAX) return { allowed: false, remaining: 0 }
  entry.count++
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count }
}

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function sanitizeInput(raw) {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (!t || t.length < 2 || t.length > MAX_INPUT_LENGTH) return null

  const injectionPatterns = [
    /ignore\s+(previous|above|all)\s+instructions/i,
    /system\s*prompt/i,
    /you\s+are\s+now/i,
    /forget\s+(everything|all)/i,
    /<\s*script/i,
    /javascript:/i,
    /\beval\s*\(/i
  ]

  if (injectionPatterns.some(p => p.test(t))) return null
  return t.replace(/[<>"'`\\]/g, '').slice(0, MAX_INPUT_LENGTH)
}

function corsHeaders(origin) {
  const dev     = process.env.NODE_ENV === 'development'
  const allowed = !ALLOWED_ORIGIN || origin === ALLOWED_ORIGIN || dev

  return {
    'Access-Control-Allow-Origin':  allowed ? (origin || '*') : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400'
  }
}

module.exports = async function handler(req, res) {
  const origin  = req.headers.origin || ''
  const headers = corsHeaders(origin)

  if (req.method === 'OPTIONS') return res.status(204).set(headers).end()
  if (req.method !== 'POST')    return res.status(405).set(headers).json({ error: 'Method not allowed' })

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown'
  const { allowed, remaining } = getRateLimit(ip)

  if (!allowed) {
    return res.status(429).set({ ...headers, 'Retry-After': '60' })
      .json({ error: 'Demasiadas solicitudes. Intenta en 60 segundos.' })
  }

  res.setHeader('X-RateLimit-Remaining', remaining)

  let body
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  } catch {
    return res.status(400).set(headers).json({ error: 'Body inválido' })
  }

  const clean = sanitizeInput(body?.company)
  if (!clean) return res.status(400).set(headers).json({ error: 'Nombre de empresa inválido.' })

  const supabaseUrl    = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  let supabase = null
  if (supabaseUrl && serviceRoleKey) {
    supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  }

  if (supabase) {
    const slug = slugify(clean)

    const { data: cached } = await supabase
      .from('audits')
      .select('*')
      .eq('company_slug', slug)
      .eq('is_public', true)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (cached) {
      return res.status(200).set(headers).json({ ...cached, from_cache: true })
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('[BALANCE360] ANTHROPIC_API_KEY no configurada')
    return res.status(500).set(headers).json({ error: 'Error de configuración del servidor' })
  }

  const systemPrompt = `Eres BALANCE360...`

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system:     systemPrompt,
        // ❌ FIX: removido "tools"
        messages: [{
          role: 'user',
          content: `Analiza el producto digital de: ${clean}`
        }]
      })
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error('[BALANCE360] API error:', response.status, errText.slice(0, 300))
      return res.status(502).set(headers).json({ error: 'Error al consultar el agente' })
    }

    const apiData = await response.json()

    const fullText = (apiData.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')

    let parsed
    try {
      const match = fullText.match(/\{[\s\S]*\}/)
      if (!match) throw new Error('No JSON encontrado')
      parsed = JSON.parse(match[0])
    } catch (e) {
      console.error('[BALANCE360] Parse error:', fullText.slice(0, 300))
      return res.status(500).set(headers).json({ error: 'Error al procesar respuesta del agente' })
    }

    return res.status(200).set(headers).json({ ...parsed, from_cache: false })

  } catch (err) {
    console.error('[BALANCE360] Unexpected error:', err.message)
    return res.status(500).set(headers).json({ error: 'Error interno del servidor' })
  }
}