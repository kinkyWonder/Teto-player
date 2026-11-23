import { useId } from 'react';

/** Teto logo: a tiny spiral drill — a nod to the name, deliberately not a note or a waveform. Uses theme accents. */
export const DRILL_BODY = 'M6 4.2C5.4 10 8.4 16.4 12 22.6C15.6 16.4 18.6 10 18 4.2C14 2.9 10 2.9 6 4.2Z';
export const DRILL_GROOVES = 'M5.6 7.4C10 9.6 14.4 8.6 18.4 6.1M6.6 11.5C10.4 13.4 13.6 12.8 17.4 10.3M8.2 15.5C10.6 16.9 12.8 16.7 15.6 14.6M10 19.1C11.3 19.9 12.2 19.8 13.8 18.6';

export function Logo({ s = 18, className }: { s?: number; className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={'logo' + (className ? ' ' + className : '')} viewBox="0 0 24 24" width={s} height={s} aria-hidden>
      <defs>
        <linearGradient id={'g' + id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="rgb(var(--acc2))" />
          <stop offset="1" stopColor="rgb(var(--acc))" />
        </linearGradient>
        <clipPath id={'c' + id}><path d={DRILL_BODY} /></clipPath>
      </defs>
      <g transform="rotate(-28 12 12)">
        <path d={DRILL_BODY} fill={`url(#g${id})`} />
        <path d={DRILL_GROOVES} clipPath={`url(#c${id})`} fill="none" stroke="var(--bg)" strokeWidth="1.35" strokeLinecap="round" />
      </g>
    </svg>
  );
}
