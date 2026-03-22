// src/components/ScoreRing.jsx
export function ScoreRing({ score = 0, size = 120 }) {
  const radius = 46
  const circ = 2 * Math.PI * radius
  const offset = circ - (score / 100) * circ

  const color = score >= 75 ? '#00E676'
              : score >= 50 ? '#00E5FF'
              : score >= 30 ? '#FFB347'
              : '#FF4757'

  return (
    <div className="flex flex-col items-center gap-2">
      <svg width={size} height={size} viewBox="0 0 100 100">
        <circle
          cx="50" cy="50" r={radius}
          fill="none" stroke="#1C2333" strokeWidth="6"
        />
        <circle
          cx="50" cy="50" r={radius}
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          className="score-ring"
          transform="rotate(-90 50 50)"
        />
        <text
          x="50" y="46"
          textAnchor="middle"
          dominantBaseline="central"
          fill={color}
          fontSize="20"
          fontWeight="600"
          fontFamily="Space Grotesk, sans-serif"
        >
          {score}
        </text>
        <text
          x="50" y="64"
          textAnchor="middle"
          fill="#64748B"
          fontSize="8"
          fontFamily="Space Grotesk, sans-serif"
        >
          BALANCE360 SCORE
        </text>
      </svg>
    </div>
  )
}
