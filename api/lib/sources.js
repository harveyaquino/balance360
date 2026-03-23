const USER_AGENT = 'Mozilla/5.0 (compatible; BALANCE360/0.5; +https://balance360.app)'

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

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' }
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} en ${url}`)
  }

  return response.text()
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
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

function pickOfficialWebsite(company, search) {
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return search.links.find((item) => {
    const href = item.href.toLowerCase()
    return !href.includes('duckduckgo.com') && (href.includes(slug) || item.title.toLowerCase().includes(company.toLowerCase()))
  }) || null
}

function pickSocialLinks(search) {
  const known = ['linkedin.com', 'instagram.com', 'facebook.com', 'x.com', 'twitter.com', 'youtube.com', 'tiktok.com']
  return search.links.filter((item) => known.some((domain) => item.href.includes(domain))).slice(0, 5)
}

async function getWebsiteEvidence(company) {
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

  const search = await searchDuckDuckGo(`${company} sitio oficial`)
  const official = pickOfficialWebsite(company, search)
  return {
    found: Boolean(official),
    url: official?.href || null,
    title: official?.title || '',
    description: search.snippets[0] || '',
    source: official ? 'search' : 'none'
  }
}

async function getOrganicEvidence(company) {
  const search = await searchDuckDuckGo(company)
  return {
    found: search.links.length > 0,
    mentionsCount: search.links.length,
    topLinks: search.links.slice(0, 5),
    snippets: search.snippets.slice(0, 4)
  }
}

async function getSocialEvidence(company) {
  const search = await searchDuckDuckGo(`${company} linkedin instagram facebook x`)
  const links = pickSocialLinks(search)
  return {
    found: links.length > 0,
    profiles: links,
    count: links.length
  }
}

async function getGooglePlacesEvidence(company) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    return { found: false, source: 'google_places', error: 'GOOGLE_MAPS_API_KEY no configurada' }
  }

  try {
    const body = { textQuery: company, languageCode: 'es' }
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

async function getAppStoreEvidence(company) {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(company)}&entity=software&limit=5`
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

async function getPlayStoreEvidence(company) {
  const apiKey = process.env.SERPAPI_API_KEY
  if (!apiKey) {
    return { found: false, source: 'serpapi', error: 'SERPAPI_API_KEY no configurada', app: null }
  }

  try {
    const searchUrl = `https://serpapi.com/search.json?engine=google_play&store=apps&q=${encodeURIComponent(company)}&api_key=${encodeURIComponent(apiKey)}`
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

export async function collectPublicSignals(company) {
  const [website, organic, social, maps, appStore, playStore] = await Promise.all([
    getWebsiteEvidence(company),
    getOrganicEvidence(company),
    getSocialEvidence(company),
    getGooglePlacesEvidence(company),
    getAppStoreEvidence(company),
    getPlayStoreEvidence(company)
  ])

  const confidenceScore = scoreFromSignals({
    hasWebsite: website.found,
    organicCount: organic.mentionsCount,
    hasAppStore: appStore.found,
    hasPlayStore: playStore.found,
    socialCount: social.count,
    hasMaps: maps.found
  })

  return {
    company,
    confidenceScore,
    existenceLikely: confidenceScore >= 36,
    web: website,
    organic_mentions: organic,
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
      organicTopLinks: organic.topLinks || []
    }
  }
}

export function buildSignalsSummary(signals) {
  const lines = [
    `Empresa evaluada: ${signals.company}`,
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

  if (signals.organic_mentions.snippets?.length) {
    lines.push('Snippets orgánicos relevantes:')
    signals.organic_mentions.snippets.slice(0, 3).forEach((item, index) => {
      lines.push(`${index + 1}. ${item}`)
    })
  }

  return lines.join('\n')
}

