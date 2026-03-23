const USER_AGENT = 'Mozilla/5.0 (compatible; BALANCE360/0.4; +https://balance360.app)'

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function normalizeName(value) {
  return normalizeWhitespace(value).toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
}

function tokenize(value) {
  return normalizeName(value).split(' ').filter((token) => token.length >= 3)
}

function tokenizeStrict(value) {
  return normalizeName(value).split(' ').filter((token) => token.length >= 4)
}

function overlapScore(left, right) {
  const leftTokens = tokenize(left)
  const rightTokens = tokenize(right)
  if (!leftTokens.length || !rightTokens.length) return 0

  const rightSet = new Set(rightTokens)
  const matches = leftTokens.filter((token) => rightSet.has(token)).length
  return matches / Math.max(leftTokens.length, rightTokens.length)
}

function decodeDuckDuckGoHref(rawHref) {
  const href = String(rawHref || '').trim()
  if (!href) return ''
  if (!href.includes('duckduckgo.com/l/?')) return href

  try {
    const parsed = new URL(href.startsWith('http') ? href : `https:${href}`)
    const target = parsed.searchParams.get('uddg')
    return target ? decodeURIComponent(target) : href
  } catch {
    return href
  }
}

function isCompanyMentionLikely(company, text) {
  const companyNorm = normalizeName(company)
  const textNorm = normalizeName(text)
  if (!companyNorm || !textNorm) return false
  if (textNorm.includes(companyNorm)) return true

  const companyTokens = tokenizeStrict(company)
  if (!companyTokens.length) return false

  const textTokens = new Set(tokenizeStrict(text))
  const tokenMatches = companyTokens.filter((token) => textTokens.has(token)).length

  if (companyTokens.length === 1) return tokenMatches === 1
  return tokenMatches >= Math.min(2, companyTokens.length)
}

function companyRelevanceScore(company, candidate) {
  const text = normalizeWhitespace(candidate)
  const overlap = overlapScore(company, text)
  return isCompanyMentionLikely(company, text) ? Math.max(0.55, overlap) : overlap
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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8' }
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
    const href = decodeDuckDuckGoHref(match[1])
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

function scoreFromSignals({ hasWebsite, organicCount, hasApp, socialCount, hasMaps }) {
  let score = 8
  if (hasWebsite) score += 30
  if (organicCount >= 4) score += 22
  else if (organicCount >= 2) score += 14
  else if (organicCount >= 1) score += 7
  if (hasApp) score += 20
  if (socialCount >= 2) score += 15
  else if (socialCount >= 1) score += 8
  if (hasMaps) score += 13
  return Math.max(8, Math.min(95, score))
}

function pickOfficialWebsite(company, search) {
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return search.links.find((item) => {
    const href = item.href.toLowerCase()
    const hasBrandSignal = companyRelevanceScore(company, `${item.title} ${item.href}`) >= 0.45
    return !href.includes('duckduckgo.com') && hasBrandSignal && (href.includes(slug) || item.title.toLowerCase().includes(company.toLowerCase()))
  }) || null
}

function pickSocialLinks(search) {
  const known = ['linkedin.com', 'instagram.com', 'facebook.com', 'x.com', 'twitter.com', 'youtube.com', 'tiktok.com']
  return search.links.filter((item) => known.some((domain) => item.href.includes(domain))).slice(0, 5)
}

function pickMapsLink(search) {
  return search.links.find((item) => /google\.[^/]+\/maps|maps\.apple\.com/i.test(item.href)) || null
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
  const links = search.links
    .map((item) => ({
      ...item,
      relevance: companyRelevanceScore(company, `${item.title} ${item.href}`)
    }))
    .filter((item) => item.relevance >= 0.42)

  const snippets = search.snippets
    .map((item) => ({ text: item, relevance: companyRelevanceScore(company, item) }))
    .filter((item) => item.relevance >= 0.38)
    .map((item) => item.text)

  return {
    found: links.length > 0 || snippets.length > 0,
    mentionsCount: links.length,
    topLinks: links.slice(0, 5),
    snippets: snippets.slice(0, 4)
  }
}

async function getSocialEvidence(company) {
  const search = await searchDuckDuckGo(`${company} linkedin instagram facebook x`)
  const links = pickSocialLinks(search).filter((item) =>
    companyRelevanceScore(company, `${item.title} ${item.href}`) >= 0.4
  )
  return {
    found: links.length > 0,
    profiles: links,
    count: links.length
  }
}

async function getMapsEvidence(company) {
  const search = await searchDuckDuckGo(`${company} google maps`)
  const link = pickMapsLink(search)
  const relevance = companyRelevanceScore(company, `${link?.title || ''} ${link?.href || ''} ${search.snippets[0] || ''}`)
  return {
    found: Boolean(link) && relevance >= 0.35,
    link: link?.href || null,
    title: link?.title || '',
    snippet: search.snippets[0] || ''
  }
}

async function getAppStoreEvidence(company) {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(company)}&entity=software&limit=5`
    const data = await fetchJson(url)
    const results = Array.isArray(data.results) ? data.results : []
    const companyTokens = tokenize(company)
    const ranked = results
      .map((item) => {
        const titleScore = overlapScore(company, item.trackName || '')
        const sellerScore = overlapScore(company, item.sellerName || '')
        const combinedScore = Math.max(titleScore, sellerScore)
        return { item, combinedScore, titleScore, sellerScore }
      })
      .filter((entry) => {
        const title = normalizeName(entry.item.trackName || '')
        const seller = normalizeName(entry.item.sellerName || '')
        const companyName = normalizeName(company)
        const directTitleMatch = companyName && title.includes(companyName)
        const directSellerMatch = companyName && seller.includes(companyName)
        const tokenMatch = companyTokens.some((token) => title.includes(token) || seller.includes(token))
        return directTitleMatch || directSellerMatch || (tokenMatch && entry.combinedScore >= 0.34)
      })
      .sort((a, b) => b.combinedScore - a.combinedScore)

    const first = ranked[0]?.item || null

    return {
      found: Boolean(first),
      resultsCount: results.length,
      app: first ? {
        name: first.trackName,
        seller: first.sellerName,
        averageRating: first.averageUserRating || null,
        ratingCount: first.userRatingCount || 0,
        url: first.trackViewUrl || null,
        relevanceScore: ranked[0]?.combinedScore || 0
      } : null
    }
  } catch (error) {
    return { found: false, resultsCount: 0, app: null, error: error.message }
  }
}

export async function collectPublicSignals(company) {
  const [website, organic, social, maps, appStore] = await Promise.all([
    getWebsiteEvidence(company),
    getOrganicEvidence(company),
    getSocialEvidence(company),
    getMapsEvidence(company),
    getAppStoreEvidence(company)
  ])

  const confidenceScore = scoreFromSignals({
    hasWebsite: website.found,
    organicCount: organic.mentionsCount,
    hasApp: appStore.found,
    socialCount: social.count,
    hasMaps: maps.found
  })

  return {
    company,
    confidenceScore,
    existenceLikely: confidenceScore >= 45,
    web: website,
    organic_mentions: organic,
    rrss: social,
    google_business: maps,
    app: appStore,
    reviews: {
      found: Boolean(appStore.app?.ratingCount || maps.found),
      sources: {
        app_store: appStore.app ? {
          averageRating: appStore.app.averageRating,
          ratingCount: appStore.app.ratingCount
        } : null,
        maps: maps.found ? { title: maps.title, snippet: maps.snippet } : null
      }
    },
    evidence: {
      website: website.url || null,
      appStore: appStore.app?.url || null,
      maps: maps.link || null,
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
    signals.app.found
      ? `App Store: encontrada (${signals.app.app?.name || 'sin nombre'})`
      : 'App Store: no encontrada'
  )

  lines.push(
    signals.google_business.found
      ? `Google Business/Maps: señal detectada (${signals.google_business.title || 'listado visible'})`
      : 'Google Business/Maps: no encontrado'
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
