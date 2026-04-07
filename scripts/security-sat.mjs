const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'
const ORIGIN = process.env.TEST_ORIGIN || BASE_URL

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function run() {
  const analyzeEndpoint = `${BASE_URL.replace(/\/$/, '')}/api/analyze`
  const bootstrapEndpoint = `${BASE_URL.replace(/\/$/, '')}/api/bootstrap-workspace`

  const preflight = await fetch(analyzeEndpoint, {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN }
  })
  assert(preflight.status === 204, `OPTIONS /api/analyze esperaba 204 y devolvió ${preflight.status}`)

  const originHeader = preflight.headers.get('access-control-allow-origin')
  assert(originHeader, 'Falta access-control-allow-origin en /api/analyze')

  const bootstrapProbe = await fetch(bootstrapEndpoint, {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  })
  assert(
    bootstrapProbe.status === 401,
    `POST /api/bootstrap-workspace sin auth esperaba 401 y devolvió ${bootstrapProbe.status}`
  )

  console.log('[SAT] OK: criterios de aceptación de seguridad validados')
}

run().catch((error) => {
  console.error(`[SAT] FAIL: ${error.message}`)
  process.exit(1)
})
