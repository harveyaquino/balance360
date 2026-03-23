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

function ScoreBar({ score }) {
  const color = score >= 75
    ? 'bg-balance360-success'
    : score >= 50
      ? 'bg-balance360-accent'
      : score >= 30
        ? 'bg-balance360-warn'
        : 'bg-balance360-danger'

  return (
    <div className="w-full bg-balance360-border rounded-full h-1 mt-2">
      <div
        className={`h-1 rounded-full transition-all duration-1000 ${color}`}
        style={{ width: `${score}%` }}
      />
    </div>
  )
}

export function FrenteCard({ name, data }) {
  const label = FRENTE_LABELS[name] || name
  const icon = FRENTE_ICONS[name] || '•'
  const safe = (text) => DOMPurify.sanitize(String(text || ''), { ALLOWED_TAGS: [] })

  return (
    <div className="frente-card animate-fade-in-up">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-balance360-accent font-mono text-sm">{icon}</span>
          <span className="text-balance360-text font-medium text-sm">{label}</span>
        </div>
        <span
          className="font-mono text-sm font-semibold"
          style={{
            color: data.score >= 75
              ? '#00E676'
              : data.score >= 50
                ? '#00E5FF'
                : data.score >= 30
                  ? '#FFB347'
                  : '#FF4757'
          }}
        >
          {data.score}
        </span>
      </div>

      <ScoreBar score={data.score} />

      {data.hallazgos?.length > 0 && (
        <div className="mt-3">
          <p className="text-balance360-muted text-xs uppercase tracking-wider mb-1">Hallazgos</p>
          <ul className="space-y-1">
            {data.hallazgos.map((hallazgo, index) => (
              <li key={index} className="text-balance360-text text-xs flex gap-2">
                <span className="text-balance360-muted mt-0.5">—</span>
                <span>{safe(hallazgo)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.oportunidades?.length > 0 && (
        <div className="mt-3">
          <p className="text-balance360-muted text-xs uppercase tracking-wider mb-1">Oportunidades</p>
          <ul className="space-y-1">
            {data.oportunidades.map((oportunidad, index) => (
              <li key={index} className="text-balance360-success text-xs flex gap-2">
                <span className="mt-0.5">+</span>
                <span>{safe(oportunidad)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
