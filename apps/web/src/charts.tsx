import { useId } from 'react'

// Gráficos em SVG puro (sem biblioteca): linha com área e rosca (pizza).
const W = 600, H = 200, PAD = 12

export type Point = { key: string; label: string; value: number; title: string }

export function LineChart({ points, label, format = String, empty }: { points: Point[]; label: string; format?: (n: number) => string; empty: string }) {
  const max = Math.max(1, ...points.map((p) => p.value))
  const x = (i: number) => PAD + (i * (W - PAD * 2)) / Math.max(1, points.length - 1)
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2)
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  const area = `${line} L${x(points.length - 1)},${H - PAD} L${x(0)},${H - PAD} Z`
  const total = points.reduce((n, p) => n + p.value, 0)
  const peak = points.reduce((best, p, i) => (p.value > points[best].value ? i : best), 0)
  const fillId = useId()
  return (
    <div className="chart">
      <div className="line-wrap">
        <span className="y-max">{format(max)}</span>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} className="line-chart">
          <defs>
            <linearGradient id={fillId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity=".28" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={PAD} x2={W - PAD} y1={PAD + f * (H - PAD * 2)} y2={PAD + f * (H - PAD * 2)} className="grid-line" />)}
          {total > 0 && <path d={area} fill={`url(#${fillId})`} />}
          <path d={line} className="line" />
          {points.map((p, i) => (
            <circle key={p.key} cx={x(i)} cy={y(p.value)} r={i === peak && total ? 4.5 : 3} className={i === peak && total ? 'pt peak' : 'pt'}>
              <title>{p.title}</title>
            </circle>
          ))}
        </svg>
      </div>
      <div className="axis" aria-hidden="true">{points.map((p) => <span key={p.key}>{p.label}</span>)}</div>
      {!total && <p className="chart-empty">{empty}</p>}
    </div>
  )
}

export type Slice = { key: string; label: string; value: number }
// Paleta categórica: tons que se distinguem no claro e no escuro.
const COLORS = ['var(--accent)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)']

export function Donut({ slices, label, format = String, center, empty }: { slices: Slice[]; label: string; format?: (n: number) => string; center: string; empty: string }) {
  const data = slices.filter((s) => s.value > 0)
  const total = data.reduce((n, s) => n + s.value, 0)
  const R = 15.9155 // circunferência = 100, então cada fatia usa o próprio percentual
  let offset = 25
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 42 42" className="donut" role="img" aria-label={`${label}: ${data.map((s) => `${s.label} ${format(s.value)}`).join(', ') || empty}`}>
        <circle cx="21" cy="21" r={R} className="donut-track" />
        {data.map((s, i) => {
          const pct = (s.value / total) * 100
          const el = <circle key={s.key} cx="21" cy="21" r={R} stroke={COLORS[i % COLORS.length]} strokeDasharray={`${pct} ${100 - pct}`} strokeDashoffset={offset} className="donut-slice"><title>{`${s.label}: ${format(s.value)}`}</title></circle>
          offset -= pct
          return el
        })}
        <text x="21" y="20" className="donut-total">{total ? format(total) : '0'}</text>
        <text x="21" y="25.5" className="donut-caption">{center}</text>
      </svg>
      {data.length ? (
        <ul className="legend">{data.map((s, i) => (
          <li key={s.key}>
            <span className="swatch" style={{ background: COLORS[i % COLORS.length] }} />
            <span className="legend-label">{s.label}</span>
            <strong>{format(s.value)}</strong>
            <span className="muted">{Math.round((s.value / total) * 100)}%</span>
          </li>))}
        </ul>
      ) : <p className="chart-empty">{empty}</p>}
    </div>
  )
}
