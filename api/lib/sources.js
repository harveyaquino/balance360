const USER_AGENT = 'Mozilla/5.0 (compatible; BALANCE360/0.5; +https://balance360.app)'
const FETCH_TIMEOUT_MS = Number(process.env.SIGNALS_FETCH_TIMEOUT_MS || 9000)

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function normalizeName(value) {
  return normalizeWhitespace(value).toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
}

function tokenize(value) {
  return normalizeName(value).split(' ').filter((token) => token.length >= 3)
}

function overlapScore(left, right) {
  const leftTokens = tokenize(left)
  const rightTokens = tokenize(right)
  if (!leftTokens.length || !rightTokens.length) return 0

  const rightSet = new Set(rightTokens)
  const matches = leftTokens.filter((token) => rightSet.has(token)).length
  return matches / Math.max(leftTokens.length, rightTokens.length)
}

function stripHtml(value) {
  return normalizeWhitespace(
    String(value || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  )
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' }
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} en ${url}`)
  }

  return response.text()
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, {
    ...options,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
      ...(options.headers || {})
    }
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} en ${url}`)
  }

  return response.json()
}

function extractLinksFromDuckDuckGo(html) {
  const links = []
  const pattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let match

  while ((match = pattern.exec(html)) && links.length < 8) {
    const href = match[1]
    const title = stripHtml(match[2])
    if (!href || !title) continue
    links.push({ href, title })
  }

  return links
}

function extractSnippetsFromDuckDuckGo(html) {
  const snippets = []
  const pattern = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  let match

  while ((match = pattern.exec(html)) && snippets.length < 8) {
    const text = stripHtml(match[1])
    if (!text) continue
    snippets.push(text)
  }

  return snippets
}

async function searchDuckDuckGo(query) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const html = await fetchText(url)
    return {
      query,
      links: extractLinksFromDuckDuckGo(html),
      snippets: extractSnippetsFromDuckDuckGo(html)
    }
  } catch (error) {
    return { query, links: [], snippets: [], error: error.message }
  }
}

function scoreFromSignals({ hasWebsite, organicCount, hasAppStore, hasPlayStore, socialCount, hasMaps }) {
  let score = 10
  if (hasWebsite) score += 22
  if (organicCount >= 3) score += 16
  else if (organicCount >= 1) score += 9
  if (hasAppStore) score += 13
  if (hasPlayStore) score += 17
  if (socialCount >= 2) score += 12
  else if (socialCount >= 1) score += 6
  if (hasMaps) score += 16
  return Math.max(10, Math.min(95, score))
}

function toHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

function hasHeavyNonLatin(text) {
  const value = String(text || '')
  if (!value) return false
  const nonLatin = (value.match(/[^\u0000-\u024F\s0-9.,:;!?'"()\-_/]/g) || []).length
  const letters = (value.match(/[A-Za-z\u00C0-\u024F]/g) || []).length
  return nonLatin > 6 && nonLatin > letters
}

function countryToken(country) {
  const normalized = normalizeName(country)
  if (normalized.includes('peru')) return ['peru', 'pe']
  if (normalized.includes('chile')) return ['chile', 'cl']
  if (normalized.includes('colombia')) return ['colombia', 'co']
  if (normalized.includes('mexico')) return ['mexico', 'mx']
  if (normalized.includes('argentina')) return ['argentina', 'ar']
  return []
}

function pickOfficialWebsite(company, search, marketCountry = '') {
  const slug = normalizeName(company).replace(/\s+/g, '')
  const tokens = tokenize(company)
  const cTokens = countryToken(marketCountry)

  const blockedDomains = ['wikipedia.org', 'facebook.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com', 'youtube.com', 'tiktok.com']

  const ranked = search.links
    .map((item) => {
      const href = String(item.href || '').toLowerCase()
      const title = String(item.title || '')
      const titleLower = title.toLowerCase()
      const host = toHostname(href)
      if (!host || href.includes('duckduckgo.com')) return null
      if (blockedDomains.some((domain) => host.includes(domain))) return null
      if (hasHeavyNonLatin(title)) return null

      const tokenMatches = tokens.filter((token) => host.includes(token) || titleLower.includes(token)).length
      const baseScore = overlapScore(company, `${host} ${title}`)
      const hostScore = host.includes(slug) ? 0.55 : 0
      const tokenScore = tokenMatches * 0.18
      const countryScore = cTokens.some((token) => host.includes(`.${token}`) || host.includes(`-${token}`) || titleLower.includes(token)) ? 0.15 : 0
      const score = baseScore + hostScore + tokenScore + countryScore

      return { ...item, host, score }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)

  return ranked[0]?.score >= 0.32 ? ranked[0] : null
}

async function fetchWebsiteMetadata(url) {
  if (!url) return { title: '', description: '' }
  try {
    const html = await fetchText(url)
    const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || ''
    const description = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] || ''
    return {
      title: stripHtml(title),
      description: stripHtml(description)
    }
  } catch {
    return { title: '', description: '' }
  }
}

function pickSocialLinks(search) {
  const known = ['linkedin.com', 'instagram.com', 'facebook.com', 'x.com', 'twitter.com', 'youtube.com', 'tiktok.com']
  return search.links.filter((item) => known.some((domain) => item.href.includes(domain))).slice(0, 5)
}

function withMarket(query, marketCountry) {
  const market = normalizeWhitespace(marketCountry)
  if (!market) return query
  return `${query} ${market}`.trim()
}

async function getWebsiteEvidence(company, marketCountry = '') {
  const directCandidates = [
    `https://${company.toLowerCase().replace(/\s+/g, '')}.com`,
    `https://www.${company.toLowerCase().replace(/\s+/g, '')}.com`
  ]

  for (const candidate of directCandidates) {
    try {
      const html = await fetchText(candidate)
      const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || ''
      const description = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] || ''
      return {
        found: true,
        url: candidate,
        title: stripHtml(title),
        description: stripHtml(description),
        source: 'direct'
      }
    } catch {
      continue
    }
  }

  const search = await searchDuckDuckGo(withMarket(`${company} sitio oficial`, marketCountry))
  const official = pickOfficialWebsite(company, search, marketCountry)
  const metadata = await fetchWebsiteMetadata(official?.href)
  return {
    found: Boolean(official),
    url: official?.href || null,
    title: metadata.title || official?.title || '',
    description: metadata.description || '',
    source: official ? 'search' : 'none'
  }
}

async function getOrganicEvidence(company, marketCountry = '') {
  const search = await searchDuckDuckGo(withMarket(company, marketCountry))
  return {
    found: search.links.length > 0,
    mentionsCount: search.links.length,
    topLinks: search.links.slice(0, 5),
    snippets: search.snippets.slice(0, 4)
  }
}

function extractNewsItems(xml) {
  const items = []
  const blocks = String(xml || '').match(/<item>[\s\S]*?<\/item>/gi) || []

  for (const block of blocks.slice(0, 10)) {
    const title = stripHtml(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '')
    const link = stripHtml(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '')
    const source = stripHtml(block.match(/<source[^>]*>([\s\S]*?)<\/source>/i)?.[1] || '')
    if (!title) continue
    items.push({ title, link, source })
  }

  return items
}

async function getNewsEvidence(company, marketCountry = '') {
  try {
    const query = encodeURIComponent(withMarket(company, marketCountry))
    const url = `https://news.google.com/rss/search?q=${query}&hl=es-419&gl=PE&ceid=PE:es-419`
    const xml = await fetchText(url)
    const items = extractNewsItems(xml)
    return {
      found: items.length > 0,
      mentionsCount: items.length,
      topItems: items.slice(0, 5)
    }
  } catch (error) {
    return { found: false, mentionsCount: 0, topItems: [], error: error.message }
  }
}

async function getSocialEvidence(company, marketCountry = '') {
  const search = await searchDuckDuckGo(withMarket(`${company} linkedin instagram facebook x`, marketCountry))
  const links = pickSocialLinks(search)
  return {
    found: links.length > 0,
    profiles: links,
    count: links.length
  }
}

async function getGooglePlacesEvidence(company, marketCountry = '') {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    return { found: false, source: 'google_places', error: 'GOOGLE_MAPS_API_KEY no configurada' }
  }

  try {
    const body = { textQuery: withMarket(company, marketCountry), languageCode: 'es' }
    const data = await fetchJson('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.googleMapsUri,places.websiteUri'
      },
      body: JSON.stringify(body)
    })

    const places = Array.isArray(data.places) ? data.places : []
    const ranked = places
      .map((place) => ({
        place,
        score: overlapScore(company, `${place.displayName?.text || ''} ${place.formattedAddress || ''}`)
      }))
      .sort((a, b) => b.score - a.score)

    const first = ranked[0]?.place || null
    const relevance = ranked[0]?.score || 0

    return {
      found: Boolean(first) && relevance >= 0.22,
      source: 'google_places',
      place: first ? {
        id: first.id,
        name: first.displayName?.text || '',
        address: first.formattedAddress || '',
        rating: first.rating || null,
        ratingCount: first.userRatingCount || 0,
        mapsUrl: first.googleMapsUri || null,
        websiteUrl: first.websiteUri || null,
        relevance
      } : null
    }
  } catch (error) {
    return { found: false, source: 'google_places', error: error.message }
  }
}

async function getAppStoreEvidence(company, marketCountry = '') {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(withMarket(company, marketCountry))}&entity=software&limit=5`
    const data = await fetchJson(url)
    const results = Array.isArray(data.results) ? data.results : []
    const ranked = results
      .map((item) => {
        const titleScore = overlapScore(company, item.trackName || '')
        const sellerScore = overlapScore(company, item.sellerName || '')
        const combinedScore = Math.max(titleScore, sellerScore)
        return { item, combinedScore }
      })
      .sort((a, b) => b.combinedScore - a.combinedScore)

    const first = ranked[0]?.item || null
    const relevanceScore = ranked[0]?.combinedScore || 0

    return {
      found: Boolean(first) && relevanceScore >= 0.24,
      resultsCount: results.length,
      app: first ? {
        productId: first.trackId,
        name: first.trackName,
        seller: first.sellerName,
        averageRating: first.averageUserRating || null,
        ratingCount: first.userRatingCount || 0,
        url: first.trackViewUrl || null,
        relevanceScore
      } : null
    }
  } catch (error) {
    return { found: false, resultsCount: 0, app: null, error: error.message }
  }
}

async function getPlayStoreEvidence(company, marketCountry = '') {
  const apiKey = process.env.SERPAPI_API_KEY
  if (!apiKey) {
    return { found: false, source: 'serpapi', error: 'SERPAPI_API_KEY no configurada', app: null }
  }

  try {
    const searchUrl = `https://serpapi.com/search.json?engine=google_play&store=apps&q=${encodeURIComponent(withMarket(company, marketCountry))}&api_key=${encodeURIComponent(apiKey)}`
    const searchData = await fetchJson(searchUrl)
    const appResults = Array.isArray(searchData.apps_results) ? searchData.apps_results : []

    const ranked = appResults
      .map((item) => {
        const title = item.title || ''
        const developer = item.developer || item.author || ''
        const packageName = item.product_id || item.id || ''
        const score = Math.max(
          overlapScore(company, title),
          overlapScore(company, developer),
          overlapScore(company, packageName)
        )
        return { item, score }
      })
      .sort((a, b) => b.score - a.score)

    const candidate = ranked[0]?.item || null
    const relevance = ranked[0]?.score || 0
    const productId = candidate?.product_id || candidate?.id || null

    if (!productId || relevance < 0.2) {
      return { found: false, source: 'serpapi', app: null, candidates: appResults.length }
    }

    const productUrl = `https://serpapi.com/search.json?engine=google_play_product&store=apps&product_id=${encodeURIComponent(productId)}&api_key=${encodeURIComponent(apiKey)}`
    const productData = await fetchJson(productUrl)
    const info = productData.product_info || {}

    return {
      found: true,
      source: 'serpapi',
      app: {
        productId,
        name: info.title || candidate.title || '',
        developer: (Array.isArray(info.authors) && info.authors[0]?.name) || candidate.developer || '',
        rating: info.rating || candidate.score || null,
        reviews: info.reviews || candidate.reviews || 0,
        downloads: info.downloads || null,
        url: productData.search_metadata?.google_play_product_url || null,
        relevance
      }
    }
  } catch (error) {
    return { found: false, source: 'serpapi', error: error.message, app: null }
  }
}

export async function collectPublicSignals(company, options = {}) {
  const marketCountry = normalizeWhitespace(options.marketCountry || '')
  const [website, organic, news, social, maps, appStore, playStore] = await Promise.all([
    getWebsiteEvidence(company, marketCountry),
    getOrganicEvidence(company, marketCountry),
    getNewsEvidence(company, marketCountry),
    getSocialEvidence(company, marketCountry),
    getGooglePlacesEvidence(company, marketCountry),
    getAppStoreEvidence(company, marketCountry),
    getPlayStoreEvidence(company, marketCountry)
  ])

  const confidenceScore = scoreFromSignals({
    hasWebsite: website.found,
    organicCount: organic.mentionsCount + Math.min(4, news.mentionsCount || 0),
    hasAppStore: appStore.found,
    hasPlayStore: playStore.found,
    socialCount: social.count,
    hasMaps: maps.found
  })

  return {
    company,
    marketCountry,
    confidenceScore,
    existenceLikely: confidenceScore >= 36,
    web: website,
    organic_mentions: organic,
    news_mentions: news,
    rrss: social,
    google_business: {
      found: maps.found,
      place: maps.place || null,
      source: maps.source || 'google_places',
      error: maps.error || null
    },
    app: {
      found: appStore.found || playStore.found,
      app_store: appStore.app || null,
      play_store: playStore.app || null
    },
    reviews: {
      found: Boolean((appStore.app?.ratingCount || 0) > 0 || (playStore.app?.reviews || 0) > 0 || maps.place?.ratingCount > 0),
      sources: {
        app_store: appStore.app ? {
          averageRating: appStore.app.averageRating,
          ratingCount: appStore.app.ratingCount
        } : null,
        play_store: playStore.app ? {
          averageRating: playStore.app.rating,
          ratingCount: playStore.app.reviews
        } : null,
        maps: maps.place ? {
          rating: maps.place.rating,
          ratingCount: maps.place.ratingCount
        } : null
      }
    },
    evidence: {
      website: website.url || maps.place?.websiteUrl || null,
      appStore: appStore.app?.url || null,
      playStore: playStore.app?.url || null,
      maps: maps.place?.mapsUrl || null,
      socialProfiles: social.profiles || [],
      organicTopLinks: organic.topLinks || [],
      newsTopItems: news.topItems || []
    }
  }
}

export function buildSignalsSummary(signals) {
  const lines = [
    `Empresa evaluada: ${signals.company}`,
    `Mercado objetivo: ${signals.marketCountry || 'sin especificar'}`,
    `Probabilidad de existencia pública detectable: ${signals.existenceLikely ? 'alta' : 'baja'} (${signals.confidenceScore}/100)`
  ]

  lines.push(
    signals.web.found
      ? `Web: encontrada (${signals.web.url || 'sin URL visible'})`
      : 'Web: no encontrada'
  )

  lines.push(
    signals.google_business?.found
      ? `Google Business: señal real detectada (${signals.google_business.place?.name || 'ficha encontrada'})`
      : 'Google Business: no encontrada'
  )

  lines.push(
    signals.app?.app_store
      ? `App Store iOS: encontrada (${signals.app.app_store.name || 'app sin nombre'})`
      : 'App Store iOS: no encontrada'
  )

  lines.push(
    signals.app?.play_store
      ? `Google Play Android: encontrada (${signals.app.play_store.name || 'app sin nombre'})`
      : 'Google Play Android: no encontrada'
  )

  lines.push(`Redes sociales: ${signals.rrss.count || 0} perfiles detectados`)
  lines.push(`Menciones orgánicas: ${signals.organic_mentions.mentionsCount || 0} resultados visibles`)
  lines.push(`Noticias recientes: ${signals.news_mentions?.mentionsCount || 0} resultados en Google News`)

  if (signals.organic_mentions.snippets?.length) {
    lines.push('Snippets orgánicos relevantes:')
    signals.organic_mentions.snippets.slice(0, 3).forEach((item, index) => {
      lines.push(`${index + 1}. ${item}`)
    })
  }

  return lines.join('\n')
}

