import { useEffect, useMemo, useRef, useState } from 'react';

export interface Point { x: string; y: number | null; lo?: number | null; hi?: number | null; n?: number }

export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) max = min + 1;
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.5; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/**
 * Single-series line chart: 2px line, optional interquartile band, crosshair tooltip and a table view.
 * One series, so the title names it and there is no legend.
 */
export function LineChart({
  title, points, format, band, height = 220, xLabel, nLabel = 'posts',
}: { title: string; points: Point[]; format: (v: number) => string; band?: boolean; height?: number; xLabel?: (x: string) => string; nLabel?: string }) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Draw at the container's pixel width so axis text stays at its CSS size.
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e?.contentRect.width ?? 720))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [table]);
  const H = height;
  const m = { t: 10, r: 16, b: 26, l: 56 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;

  const { ticks, sx, sy } = useMemo(() => {
    const vals = points.flatMap((p) => [p.y, band ? p.lo : null, band ? p.hi : null]).filter((v): v is number => typeof v === 'number');
    const lo = Math.min(0, ...vals);
    const hi = Math.max(...vals, 0);
    const t = niceTicks(lo, hi);
    const y0 = t[0]!;
    const y1 = t[t.length - 1]!;
    return {
      ticks: t,
      sx: (i: number) => m.l + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw),
      sy: (v: number) => m.t + ih - ((v - y0) / (y1 - y0 || 1)) * ih,
    };
  }, [points, band, ih, iw, m.l, m.t]);

  if (points.length === 0) return <p className="small muted">No data.</p>;

  const path = (get: (p: Point) => number | null | undefined) => {
    let d = '';
    let pen = false;
    points.forEach((p, i) => {
      const v = get(p);
      if (typeof v !== 'number') { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const bandPath = band
    ? (() => {
        const idx = points.map((p, i) => ({ p, i })).filter(({ p }) => typeof p.lo === 'number' && typeof p.hi === 'number');
        if (idx.length < 2) return '';
        return `M${idx.map(({ p, i }) => `${sx(i).toFixed(1)},${sy(p.hi!).toFixed(1)}`).join('L')}L${[...idx].reverse().map(({ p, i }) => `${sx(i).toFixed(1)},${sy(p.lo!).toFixed(1)}`).join('L')}Z`;
      })()
    : '';
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(iw / 90))));
  const fmtX = xLabel ?? ((x: string) => x);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = points.length <= 1 ? 0 : Math.round(((px - m.l) / iw) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };
  const hp = hover !== null ? points[hover] : null;

  return (
    <figure className="chart" style={{ margin: 0 }}>
      <figcaption className="row between" style={{ marginBottom: 4 }}>
        <span className="small"><b>{title}</b></span>
        <button className="sm ghost" onClick={() => setTable(!table)} aria-pressed={table}>{table ? 'Chart' : 'Table'}</button>
      </figcaption>
      {table ? (
        <div className="scroll-x" style={{ maxHeight: 320, overflowY: 'auto' }}>
          <table className="data">
            <thead><tr><th>Period</th><th className="num">Value</th>{band ? <><th className="num">25th pct</th><th className="num">75th pct</th></> : null}{points.some((p) => p.n !== undefined) ? <th className="num">{nLabel}</th> : null}</tr></thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.x}><td className="mono">{fmtX(p.x)}</td><td className="num">{p.y === null ? '—' : format(p.y)}</td>
                  {band ? <><td className="num">{typeof p.lo === 'number' ? format(p.lo) : '—'}</td><td className="num">{typeof p.hi === 'number' ? format(p.hi) : '—'}</td></> : null}
                  {p.n !== undefined ? <td className="num">{p.n}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ position: 'relative' }} ref={boxRef}>
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. Use the Table button for values.`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            <g className="grid">{ticks.map((t) => <line key={t} x1={m.l} x2={W - m.r} y1={sy(t)} y2={sy(t)} />)}</g>
            <g className="axis">
              {ticks.map((t) => <text key={t} x={m.l - 6} y={sy(t) + 3} textAnchor="end">{format(t)}</text>)}
              {points.map((p, i) => ((i % labelEvery === 0 && points.length - 1 - i >= labelEvery / 2) || i === points.length - 1 ? <text key={p.x} x={sx(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}>{fmtX(p.x)}</text> : null))}
            </g>
            <line className="baseline" x1={m.l} x2={W - m.r} y1={sy(ticks[0]!)} y2={sy(ticks[0]!)} />
            {bandPath ? <path d={bandPath} fill="var(--line)" opacity={0.14} /> : null}
            <path d={path((p) => p.y)} fill="none" stroke="var(--line)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {points.length <= 40 ? points.map((p, i) => (typeof p.y === 'number' ? <circle key={p.x} cx={sx(i)} cy={sy(p.y)} r={hover === i ? 4.5 : 2.5} fill="var(--line)" stroke="#fff" strokeWidth={1.5} /> : null)) : null}
            {hp && hover !== null ? (
              <>
                <line x1={sx(hover)} x2={sx(hover)} y1={m.t} y2={m.t + ih} stroke="var(--ink)" strokeDasharray="2 3" />
                {typeof hp.y === 'number' ? <circle cx={sx(hover)} cy={sy(hp.y)} r={4.5} fill="var(--line)" stroke="#fff" strokeWidth={2} /> : null}
              </>
            ) : null}
          </svg>
          {hp && hover !== null ? (
            <div className="tip" style={{ left: `${(sx(hover) / W) * 100}%`, top: `${((typeof hp.y === 'number' ? sy(hp.y) : m.t) / H) * 100}%` }}>
              <b>{fmtX(hp.x)}</b> · {hp.y === null ? 'no data' : format(hp.y)}
              {band && typeof hp.lo === 'number' && typeof hp.hi === 'number' ? <div>IQR {format(hp.lo)}–{format(hp.hi)}</div> : null}
              {hp.n !== undefined ? <div>{hp.n} {nLabel}</div> : null}
            </div>
          ) : null}
        </div>
      )}
    </figure>
  );
}
