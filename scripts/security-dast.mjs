const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'
const ORIGIN = process.env.TEST_ORIGIN || BASE_URL

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function run() {
  const endpoint = `${BASE_URL.replace(/\/$/, '')}/api/analyze`

  const methodProbe = await fetch(endpoint, {
    method: 'GET',
    headers: { Origin: ORIGIN }
  })
  assert(methodProbe.status === 405, `GET /api/analyze esperaba 405 y devolvió ${methodProbe.status}`)

  const unauthProbe = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN
    },
    body: JSON.stringify({ company: 'BCP' })
  })
  assert(
    unauthProbe.status === 401,
    `POST sin auth esperaba 401 y devolvió ${unauthProbe.status}`
  )

  const badInputProbe = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer fake-token-for-security-test',
      Origin: ORIGIN
    },
    body: JSON.stringify({ company: "<script>alert('x')</script>" })
  })
  assert(
    [400, 401].includes(badInputProbe.status),
    `POST input malicioso esperaba 400 o 401 y devolvió ${badInputProbe.status}`
  )

  console.log('[DAST] OK: controles base validados')
}

run().catch((error) => {
  console.error(`[DAST] FAIL: ${error.message}`)
  process.exit(1)
})
