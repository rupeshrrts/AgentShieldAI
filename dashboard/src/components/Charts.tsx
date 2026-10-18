import React, { useEffect, useRef, useState } from 'react';

/**
 * Small dependency-free SVG charts for the Overview page.
 * Colours: the categorical/action palettes below were checked with the dataviz palette validator
 * (adjacent CVD and normal-vision separation on a white surface). Several slots sit below 3:1
 * contrast, so every chart shows a legend with labels and values (never colour alone).
 */

export interface Slice {
  label: string;
  value: number;
  color: string;
}

// Fixed categorical order (colour follows the entity, never its rank)
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
// Actions keep the same colour on every chart
export const ACTION_COLORS: Record<string, string> = {
  BLOCK: '#e34948',
  WARN: '#eda100',
  REDACT: '#2a78d6',
  MONITOR: '#e87ba4',
  ALLOW: '#1baf7a',
};
// Severity uses the status steps (critical / serious / warning) and blue for low
export const SEVERITY_COLORS: Record<string, string> = {
  CRITICAL: '#d03b3b',
  HIGH: '#ec835a',
  MEDIUM: '#fab219',
  LOW: '#2a78d6',
};

const fmt = (n: number) => n.toLocaleString();

interface Tip {
  x: number;
  y: number;
  title: string;
  lines: Array<{ color?: string; label: string; value: string }>;
}

const Tooltip: React.FC<{ tip: Tip | null }> = ({ tip }) =>
  tip ? (
    <div
      role="tooltip"
      style={{
        position: 'absolute', left: tip.x, top: tip.y, transform: 'translate(-50%, calc(-100% - 10px))', pointerEvents: 'none',
        background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '8px 10px',
        boxShadow: '0 6px 20px rgba(15, 23, 42, 0.12)', fontSize: '12px', whiteSpace: 'nowrap', zIndex: 5,
      }}
    >
      <div style={{ fontWeight: 700, color: 'var(--text-main)', marginBottom: tip.lines.length ? 4 : 0 }}>{tip.title}</div>
      {tip.lines.map((l) => (
        <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-secondary)' }}>
          {l.color && <span style={{ width: 8, height: 8, borderRadius: 2, background: l.color }} />}
          <span>{l.label}</span>
          <span style={{ marginLeft: 'auto', paddingLeft: 12, fontWeight: 600, color: 'var(--text-main)', fontVariantNumeric: 'tabular-nums' }}>{l.value}</span>
        </div>
      ))}
    </div>
  ) : null;

/** Legend rows with label, value and share: the direct labels every chart carries. */
export const Legend: React.FC<{ slices: Slice[]; total: number }> = ({ slices, total }) => (
  // At least 190px wide: in a narrow card the legend moves below the chart instead of cutting labels
  <div style={{ display: 'flex', flexDirection: 'column', gap: '7px', minWidth: 0, flex: '1 1 190px' }}>
    {slices.map((s) => (
      <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0 }} />
        <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-main)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmt(s.value)}</span>
        <span style={{ width: 38, textAlign: 'right', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
          {total ? Math.round((s.value / total) * 100) : 0}%
        </span>
      </div>
    ))}
  </div>
);

function arcPath(cx: number, cy: number, r: number, inner: number, start: number, end: number): string {
  const p = (radius: number, a: number) => [cx + radius * Math.sin(a), cy - radius * Math.cos(a)];
  const large = end - start > Math.PI ? 1 : 0;
  const [x1, y1] = p(r, start);
  const [x2, y2] = p(r, end);
  if (inner <= 0) return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
  const [x3, y3] = p(inner, end);
  const [x4, y4] = p(inner, start);
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${inner} ${inner} 0 ${large} 0 ${x4} ${y4} Z`;
}

/** Donut (or pie with `pie`) with a hover tooltip and a legend beside it. */
export const DonutChart: React.FC<{ slices: Slice[]; pie?: boolean; centerValue?: string; centerLabel?: string; size?: number }> = ({
  slices, pie = false, centerValue, centerLabel, size = 168,
}) => {
  const [tip, setTip] = useState<Tip | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const data = slices.filter((s) => s.value > 0);
  const total = data.reduce((a, s) => a + s.value, 0);
  const r = size / 2 - 4;
  const inner = pie ? 0 : r * 0.62;
  const c = size / 2;
  let angle = 0;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap' }}>
      <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }} onMouseLeave={() => { setTip(null); setActive(null); }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={data.map((s) => `${s.label} ${s.value}`).join(', ')}>
          {data.length === 1 ? (
            <circle cx={c} cy={c} r={pie ? r : (r + inner) / 2} fill={pie ? data[0].color : 'none'} stroke={pie ? 'none' : data[0].color} strokeWidth={pie ? 0 : r - inner} />
          ) : (
            data.map((s) => {
              const start = angle;
              angle += (s.value / total) * Math.PI * 2;
              const mid = (start + angle) / 2;
              return (
                <path
                  key={s.label}
                  d={arcPath(c, c, active === s.label ? r + 3 : r, inner, start, angle)}
                  fill={s.color}
                  stroke="var(--bg-surface)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  opacity={active && active !== s.label ? 0.55 : 1}
                  style={{ cursor: 'default', transition: 'opacity 120ms' }}
                  onMouseEnter={() => {
                    setActive(s.label);
                    setTip({
                      x: c + (r * 0.8) * Math.sin(mid), y: c - (r * 0.8) * Math.cos(mid), title: s.label,
                      lines: [{ color: s.color, label: 'Events', value: `${fmt(s.value)} (${Math.round((s.value / total) * 100)}%)` }],
                    });
                  }}
                />
              );
            })
          )}
          {!pie && (
            <>
              <text x={c} y={c - 2} textAnchor="middle" style={{ fontSize: 24, fontWeight: 700, fill: 'var(--text-main)' }}>{centerValue ?? fmt(total)}</text>
              <text x={c} y={c + 16} textAnchor="middle" style={{ fontSize: 11, fill: 'var(--text-muted)' }}>{centerLabel ?? 'total'}</text>
            </>
          )}
        </svg>
        <Tooltip tip={tip} />
      </div>
      <Legend slices={data} total={total} />
    </div>
  );
};

/** Horizontal bars for one series (e.g. events per site); the panel title names the series. */
export const BarList: React.FC<{ rows: Array<{ label: string; value: number }>; color?: string }> = ({ rows, color = SERIES[0] }) => {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const total = rows.reduce((a, r) => a + r.value, 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {rows.map((r) => (
        <div key={r.label} title={`${r.label}: ${fmt(r.value)} events (${total ? Math.round((r.value / total) * 100) : 0}%)`}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px', gap: '8px' }}>
            <span style={{ color: 'var(--text-secondary)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
            <span style={{ color: 'var(--text-main)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmt(r.value)}</span>
          </div>
          <div style={{ height: 10, background: 'var(--bg-primary)', borderRadius: 4 }}>
            <div style={{ width: `${(r.value / max) * 100}%`, minWidth: r.value ? 4 : 0, height: '100%', background: color, borderRadius: 4, transition: 'width 500ms ease-out' }} />
          </div>
        </div>
      ))}
    </div>
  );
};

export interface StackSeries {
  key: string;
  label: string;
  color: string;
}

/** Stacked columns per day with gridlines, a legend and a per-column hover tooltip. */
export const StackedColumns: React.FC<{ rows: Array<Record<string, any>>; series: StackSeries[]; xKey: string; height?: number }> = ({
  rows, series, xKey, height = 200,
}) => {
  const [tip, setTip] = useState<Tip | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Draw at the real pixel width so text stays readable (no viewBox scaling)
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const pad = { l: 34, r: 8, t: 10, b: 24 };
  const totals = rows.map((r) => series.reduce((a, s) => a + (Number(r[s.key]) || 0), 0));
  const rawMax = Math.max(1, ...totals);
  const step = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const max = Math.ceil(rawMax / step) * step;
  const plotH = height - pad.t - pad.b;
  const band = (width - pad.l - pad.r) / Math.max(1, rows.length);
  const barW = Math.min(28, band * 0.62);
  const y = (v: number) => pad.t + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  // About 8 date labels at most, counted back from the latest day so "today" is always labelled
  const labelStep = Math.max(1, Math.ceil(rows.length / 8));
  const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });

  return (
    <div>
      <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '8px' }}>
        {series.map((s) => (
          <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color }} /> {s.label}
          </span>
        ))}
      </div>
      <div ref={box} style={{ position: 'relative' }} onMouseLeave={() => { setTip(null); setHover(null); }}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }} role="img" aria-label="Events per day">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--border-default)' : 'var(--border-subtle)'} strokeWidth={1} />
              <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" style={{ fontSize: 10, fill: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{fmt(Math.round(t))}</text>
            </g>
          ))}
          {rows.map((r, i) => {
            const x = pad.l + band * i + (band - barW) / 2;
            let acc = 0;
            const segs = series.map((s) => ({ s, v: Number(r[s.key]) || 0 })).filter((p) => p.v > 0);
            return (
              <g key={String(r[xKey])} opacity={hover !== null && hover !== i ? 0.6 : 1}>
                {segs.map(({ s, v }, j) => {
                  const top = y(acc + v);
                  const bottom = y(acc);
                  acc += v;
                  const h = Math.max(1, bottom - top - (j < segs.length - 1 ? 2 : 0));
                  const isTop = j === segs.length - 1;
                  return isTop ? (
                    <path key={s.key} fill={s.color}
                      d={`M ${x} ${top + h} V ${top + Math.min(4, h)} Q ${x} ${top} ${x + Math.min(4, barW / 2)} ${top} H ${x + barW - Math.min(4, barW / 2)} Q ${x + barW} ${top} ${x + barW} ${top + Math.min(4, h)} V ${top + h} Z`} />
                  ) : (
                    <rect key={s.key} x={x} y={bottom - h} width={barW} height={h} fill={s.color} />
                  );
                })}
                {(rows.length - 1 - i) % labelStep === 0 && (
                  <text x={x + barW / 2} y={height - 6} textAnchor="middle" style={{ fontSize: 10, fill: 'var(--text-muted)' }}>{dayLabel(String(r[xKey]))}</text>
                )}
                {/* Hit target: the whole column band, larger than the bar */}
                <rect x={pad.l + band * i} y={pad.t} width={band} height={plotH} fill="transparent"
                  onMouseEnter={() => {
                    setHover(i);
                    setTip({
                      x: ((x + barW / 2) / width) * 100, y: 0, title: `${dayLabel(String(r[xKey]))} · ${fmt(totals[i])} events`,
                      lines: series.map((s) => ({ color: s.color, label: s.label, value: fmt(Number(r[s.key]) || 0) })),
                    });
                  }} />
              </g>
            );
          })}
        </svg>
        {tip && (
          <div style={{ position: 'absolute', left: `${tip.x}%`, top: 0, width: 0 }}>
            <Tooltip tip={{ ...tip, x: 0, y: 0 }} />
          </div>
        )}
      </div>
    </div>
  );
};
