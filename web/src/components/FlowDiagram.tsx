import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentInfo } from '@/api/contract';
import { AgentDialog } from './AgentDialog';
import { FlowSvg } from './FlowSvg';

const W = 2818;
const H = 752;
const LEGEND: { f: string; label: string; swatch: React.ReactNode }[] = [
  { f: 'chan', label: 'Channel', swatch: <span className="w-4 h-4 rounded" style={{ background: '#16a34a' }} /> },
  { f: 'agent', label: 'AI agent', swatch: <span className="w-4 h-4 rounded" style={{ background: '#9333ea' }} /> },
  { f: 'code', label: 'Code rule', swatch: <span className="w-4 h-4 rounded" style={{ background: '#2563eb' }} /> },
  { f: 'human', label: 'Human', swatch: <span className="w-4 h-4 rounded" style={{ background: '#d97706' }} /> },
  { f: 'wait', label: 'Temporal wait or timer', swatch: <span className="w-4 h-4 rounded" style={{ background: '#52525b' }} /> },
  { f: 'if', label: 'Decision', swatch: <span className="w-4 h-4 rounded" style={{ background: '#3f3f46' }} /> },
  { f: 'end', label: 'Outcome', swatch: <span className="w-4 h-4 rounded" style={{ background: '#18181b' }} /> },
  { f: 'loop', label: 'Loops back', swatch: <span className="w-6 border-t-2 border-dashed border-purple-400" /> },
];

export function Legend({ value, onChange }: { value: string; onChange: (f: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1 text-sm text-zinc-700" role="group" aria-label="Highlight">
      {LEGEND.map((l) => (
        <button key={l.f} className="lg" aria-pressed={value === l.f} onClick={() => onChange(value === l.f ? '' : l.f)}>
          {l.swatch}
          {l.label}
        </button>
      ))}
    </div>
  );
}

/** Fixed-size canvas: the box stays put; the diagram inside zooms (buttons, ctrl/cmd + wheel) and pans (drag, wheel). */
export function FlowDiagram({ filter, agents, openAgent, setOpenAgent }: {
  filter: string; agents: AgentInfo[]; openAgent: string | null; setOpenAgent: (id: string | null) => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const view = useRef({ z: 1, tx: 0, ty: 0, fit: true });
  const [label, setLabel] = useState('Fit');
  const [fs, setFs] = useState(false);

  const apply = useCallback(() => {
    const s = svg.current;
    if (!s) return;
    const v = view.current;
    s.style.transformOrigin = '0 0';
    s.style.transform = `translate(${v.tx}px,${v.ty}px) scale(${v.z})`;
    setLabel(v.fit ? 'Fit' : `${Math.round(v.z * 100)}%`);
  }, []);
  const zoomAt = useCallback((nz: number, cx: number, cy: number) => {
    const v = view.current;
    nz = Math.max(0.25, Math.min(2.5, nz));
    v.tx = cx - ((cx - v.tx) * nz) / v.z;
    v.ty = cy - ((cy - v.ty) * nz) / v.z;
    v.z = nz;
    v.fit = false;
    apply();
  }, [apply]);
  const zoom = useCallback((d: number) => {
    const b = wrap.current;
    if (!b) return;
    const v = view.current;
    if (d === 0) {
      v.z = Math.min(b.clientWidth / W, b.clientHeight / H) * 0.98;
      v.tx = (b.clientWidth - W * v.z) / 2;
      v.ty = (b.clientHeight - H * v.z) / 2;
      v.fit = true;
      apply();
      return;
    }
    zoomAt(v.z * (d > 0 ? 1.25 : 0.8), b.clientWidth / 2, b.clientHeight / 2);
  }, [apply, zoomAt]);

  /** First view: readable labels (about 80%), from the start of the flow; the Fit button shows it all. */
  const start = useCallback(() => {
    const b = wrap.current;
    if (!b) return;
    const v = view.current;
    const fitZ = Math.min(b.clientWidth / W, b.clientHeight / H) * 0.98;
    v.z = Math.max(fitZ, Math.min(0.8, (b.clientHeight / H) * 0.98));
    v.tx = v.z === fitZ ? (b.clientWidth - W * v.z) / 2 : 8;
    v.ty = (b.clientHeight - H * v.z) / 2;
    v.fit = v.z === fitZ;
    apply();
  }, [apply]);

  useLayoutEffect(() => start(), [start]);

  useEffect(() => {
    const onResize = () => view.current.fit && zoom(0);
    const onFs = () => {
      setFs(document.fullscreenElement === card.current);
      requestAnimationFrame(() => zoom(0));
    };
    addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, [zoom]);

  // pan and wheel
  useEffect(() => {
    const b = wrap.current!;
    let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
    const down = (e: PointerEvent) => {
      if ((e.target as Element).closest('.agent-node')) return;
      drag = true; sx = e.clientX; sy = e.clientY; ox = view.current.tx; oy = view.current.ty;
      b.style.cursor = 'grabbing';
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      view.current.tx = ox + e.clientX - sx;
      view.current.ty = oy + e.clientY - sy;
      view.current.fit = false;
      apply();
    };
    const up = () => { drag = false; b.style.cursor = ''; };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = b.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(view.current.z * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else { view.current.tx -= e.deltaX; view.current.ty -= e.deltaY; view.current.fit = false; apply(); }
    };
    b.addEventListener('pointerdown', down);
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    b.addEventListener('wheel', wheel, { passive: false });
    return () => {
      b.removeEventListener('pointerdown', down);
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      b.removeEventListener('wheel', wheel);
    };
  }, [apply, zoomAt]);

  // legend filter: highlight by node kind, or the loop edges
  useEffect(() => {
    const s = svg.current;
    if (!s) return;
    s.querySelectorAll('.node').forEach((n) => n.classList.toggle('on', filter === 'loop' || (n as SVGElement).dataset.kind === filter));
    s.querySelectorAll('.edge,.elab').forEach((e) => e.classList.toggle('on', filter === 'loop' && e.classList.contains('loop')));
  }, [filter]);

  // agent nodes open the prompt dialog
  useEffect(() => {
    const s = svg.current!;
    const pick = (e: Event) => (e.target as Element).closest<SVGElement>('[data-agent]')?.dataset.agent ?? null;
    const click = (e: MouseEvent) => { const id = pick(e); if (id) setOpenAgent(id); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { const id = pick(e); if (id) { e.preventDefault(); setOpenAgent(id); } } };
    s.addEventListener('click', click);
    s.addEventListener('keydown', key);
    return () => { s.removeEventListener('click', click); s.removeEventListener('keydown', key); };
  }, [setOpenAgent]);

  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else card.current?.requestFullscreen();
  };

  return (
    <div id="flow-card" ref={card} className="card relative bg-white">
      <div className="absolute right-3 top-3 z-10 flex rounded-lg border border-zinc-200 bg-white shadow-sm overflow-hidden text-sm" role="group" aria-label="Zoom">
        <button className="px-3 py-1.5 hover:bg-zinc-100" onClick={() => zoom(-1)} aria-label="Zoom out">−</button>
        <button className="px-3 py-1.5 border-x border-zinc-200 hover:bg-zinc-100" onClick={() => zoom(0)}>{label}</button>
        <button className="px-3 py-1.5 hover:bg-zinc-100" onClick={() => zoom(1)} aria-label="Zoom in">+</button>
        <button className="px-3 py-1.5 border-l border-zinc-200 hover:bg-zinc-100" onClick={fullscreen} aria-label="Full screen">
          {fs ? '✕ Exit' : '⛶ Full screen'}
        </button>
      </div>
      <div id="flow-wrap" ref={wrap} className="relative overflow-hidden cursor-grab select-none rounded-xl"
        style={{ height: 'min(62vh,620px)', background: '#fafafa radial-gradient(#e4e4e7 1px,transparent 1px) 0 0/18px 18px', touchAction: 'none' }}>
        <FlowSvg svgRef={svg} filtered={!!filter} />
      </div>
      <AgentDialog agent={agents.find((a) => a.id === openAgent) ?? null} onClose={() => setOpenAgent(null)} container={fs ? card.current : null} />
    </div>
  );
}
