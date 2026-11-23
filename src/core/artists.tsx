/** Several artists in one name: «Баста, Скриптонит», «A feat. B». Mirrors namefix::artist_parts (Rust). */
import { Fragment } from 'react';
import { navigate } from '../app/store';

const COMMA_NAMES = new Set(['earth, wind & fire', 'crosby, stills, nash & young', 'crosby, stills & nash', 'tyler, the creator',
  'emerson, lake & palmer', 'blood, sweat & tears', 'peter, paul and mary', 'ты, я и он']);
const SLASH_NAMES = new Set(['ac/dc', 'au/ra', 'n/a']);
// «/» divides only when it is single: «A / B», «A/B» — two artists; «слово//слово» — one name
const SEP = /(\s+(?:featuring|feat\.|feat|ft\.|ft)\s+|\s*[,;]\s*|\s*(?<!\/)\/(?!\/)\s*)/i;

export function artistParts(s: string): { name: string; sep: string }[] {
  const whole = (s || '').trim();
  const low = whole.toLowerCase();
  if (!whole || COMMA_NAMES.has(low) || SLASH_NAMES.has(low)) return [{ name: whole, sep: '' }];
  const bits = whole.split(SEP);
  const out: { name: string; sep: string }[] = [];
  for (let i = 0; i < bits.length; i += 2) out.push({ name: bits[i].trim(), sep: bits[i + 1] ?? '' });
  if (out.length > 1 && out.some((p) => [...p.name].length < 2)) return [{ name: whole, sep: '' }];
  return out;
}
export const splitArtists = (s: string) => artistParts(s).map((p) => p.name).filter(Boolean);
/** Case / ё-insensitive comparison key (the library already unifies translit spellings). */
export const artistKey = (s: string) => s.trim().toLowerCase().replace(/ё/g, 'е');
export const hasArtist = (s: string, name: string) => { const k = artistKey(name); return splitArtists(s).some((p) => artistKey(p) === k); };

/** Each artist of «A, B» is its own link. */
export function ArtistLinks({ name, className, before }: { name: string; className?: string; before?: () => void }) {
  return <>{artistParts(name).map((p, i) => (
    <Fragment key={i}>
      <span className={'lk' + (className ? ' ' + className : '')} onClick={(e) => { e.stopPropagation(); before?.(); navigate({ kind: 'artist', name: p.name }); }}>{p.name}</span>{p.sep}
    </Fragment>
  ))}</>;
}
