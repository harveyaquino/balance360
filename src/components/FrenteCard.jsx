import DOMPurify from 'dompurify'

const FRENTE_LABELS = {
  app: 'App móvil',
  web: 'Web',
  rrss: 'Redes sociales',
  reviews: 'Reviews',
  google_business: 'Google Business',
  organic_mentions: 'Menciones orgánicas'
}

const FRENTE_ICONS = {
  app: '◈',
  web: '◉',
  rrss: '◎',
  reviews: '◆',
  google_business: '◇',
  organic_mentions: '◌'
}

function sanitizeInsight(text) {
  const cleaned = String(text || '')
    .replace(/Anthropic\s+\d{3}:[\s\S]*/i, 'La fuente analítica todavía no está conectada a datos observables de este frente.')
    .replace(/\s+/g, ' ')
    .trim()

  return DOMPurify.sanitize(cleaned, { ALLOWED_TAGS: [] })
}

function ScoreBar({ score }) {
  const color = score >= 75
    ? 'bg-balance360-success'
    : score >= 50
      ? 'bg-balance360-accent'
      : score >= 30
        ? 'bg-balance360-warn'
        : 'bg-balance360-danger'

  return (
    <div className="w-full bg-balance360-border rounded-full h-1.5 mt-3">
      <div
        className={`h-1.5 rounded-full transition-all duration-1000 ${color}`}
        style={{ width: `${score}%` }}
      />
    </div>
  )
}

function InsightList({ title, items, tone }) {
  if (!items?.length) return null

  return (
    <div className="mt-4">
      <p className="text-balance360-muted text-[11px] uppercase tracking-[0.18em] mb-2">{title}</p>
      <ul className="space-y-2">
        {items.map((item, index) => (
          <li key={index} className={`text-xs leading-5 flex gap-2 ${tone}`}>
            <span className="mt-0.5 shrink-0">{title === 'Oportunidades' ? '+' : '—'}</span>
            <span>{sanitizeInsight(item)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function FrenteCard({ name, data }) {
  const label = FRENTE_LABELS[name] || name
  const icon = FRENTE_ICONS[name] || '•'
  const score = Number.isFinite(Number(data.score)) ? Number(data.score) : 0

  return (
    <div className="frente-card animate-fade-in-up">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="flex items-center gap-2">
          <span className="text-balance360-accent font-mono text-sm">{icon}</span>
          <span className="text-balance360-text font-medium text-sm">{label}</span>
        </div>
        <span
          className="font-mono text-base font-semibold"
          style={{
            color: score >= 75
              ? '#00E676'
              : score >= 50
                ? '#00E5FF'
                : score >= 30
                  ? '#FFB347'
                  : '#FF4757'
          }}
        >
          {score}
        </span>
      </div>

      <ScoreBar score={score} />

      <InsightList title="Hallazgos" items={data.hallazgos} tone="text-balance360-text" />
      <InsightList title="Oportunidades" items={data.oportunidades} tone="text-balance360-success" />
    </div>
  )
}
