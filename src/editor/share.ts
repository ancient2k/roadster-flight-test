// Share link: the whole level, deflated and base64url-encoded, in the URL fragment (#track=…) – no backend, and the
// fragment never reaches the server. CompressionStream: Chrome 80+, Safari 16.4+, Firefox 113+.
import { levelToJson, validateLevel, type GridSize, type ValidateResult } from '../shared/level';
import type { Level } from '../shared/level';

export const SHARE_PARAM = 'track';

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (s: string): Uint8Array => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
};

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = await new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(out);
}

/** "v1." + base64url(deflate-raw(JSON)). */
export async function encodeLevel(level: Level): Promise<string> {
  const json = new TextEncoder().encode(levelToJson(level));
  return 'v1.' + b64url(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function decodeLevel(code: string, grid: GridSize): Promise<ValidateResult> {
  const m = /^v1\.([A-Za-z0-9_-]+)$/.exec(code.trim());
  if (!m) throw new Error('not a track link');
  const json = new TextDecoder().decode(await pipe(unb64url(m[1]), new DecompressionStream('deflate-raw')));
  return validateLevel(JSON.parse(json), grid);
}

/** Full share URL of the current page with the level in the fragment. */
export async function shareUrl(level: Level, base = location.href): Promise<string> {
  const u = new URL(base);
  u.hash = `${SHARE_PARAM}=${await encodeLevel(level)}`;
  return u.toString();
}

/** The track code from a URL fragment (#track=v1.…), or null. */
export function trackCodeFromHash(hash = location.hash): string | null {
  const m = new RegExp(`[#&]${SHARE_PARAM}=([^&]+)`).exec(hash);
  return m ? decodeURIComponent(m[1]) : null;
}
