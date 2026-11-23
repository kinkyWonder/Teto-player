import { useRef, useState } from 'react';

/** Horizontal slider. value 0..1; onInput during drag, onCommit on release. */
export function Slider({ value, onInput, onCommit, className, style, onWheel }: {
  value: number; onInput?: (v: number) => void; onCommit: (v: number) => void; className?: string; style?: React.CSSProperties; onWheel?: (e: React.WheelEvent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const at = (x: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (x - r.left) / r.width));
  };
  const v = drag ?? value;
  return (
    <div ref={ref} className={'slh' + (drag !== null ? ' drag' : '') + (className ? ' ' + className : '')} style={style} onWheel={onWheel}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const x = at(e.clientX);
        setDrag(x);
        onInput?.(x);
      }}
      onPointerMove={(e) => { if (drag !== null) { const x = at(e.clientX); setDrag(x); onInput?.(x); } }}
      onPointerUp={(e) => { if (drag !== null) { onCommit(at(e.clientX)); setDrag(null); } }}>
      <div className="sl" style={{ ['--v' as string]: `${v * 100}%` }} />
    </div>
  );
}
