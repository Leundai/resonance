import { Vibrant } from 'node-vibrant/browser';
import type { Emotion, Palette } from '../types/song-analysis';

/**
 * Synthetic palette for tracks without cover art. Emotions are complex —
 * one hue is a caricature. The base hue comes from valence, but the
 * SCHEME comes from character: high arousal earns triadic contrast,
 * bright songs spread analogous, moody ones get a complementary accent.
 * A key-derived rotation keeps two songs with the same mood apart.
 */
export function emotionPalette(e: Emotion): Palette {
  // Base hue: valence path (indigo → magenta → amber), rotated by key
  // (12 keys spread over ±55°) so same-mood songs still differ.
  const keyIndex = 'C C♯ D E♭ E F F♯ G A♭ A B♭ B'.split(' ').indexOf(e.key);
  const keyShift = (Math.max(0, keyIndex) / 11 - 0.5) * 110;
  const hue = (250 + e.valence * 145 + keyShift + 360) % 360;
  const sat = 0.5 + e.arousal * 0.4;

  // Scheme by character.
  let h2: number;
  let h3: number;
  if (e.arousal > 0.65) {
    // Triadic: three genuinely different color families.
    h2 = (hue + 120) % 360;
    h3 = (hue + 240) % 360;
  } else if (e.valence > 0.55) {
    // Wide analogous: a warm flowing gradient.
    h2 = (hue + 55) % 360;
    h3 = (hue + 310) % 360;
  } else {
    // Complementary accent against a moody base.
    h2 = (hue + 160) % 360;
    h3 = (hue + 30) % 360;
  }

  const primary = hslHex(hue, sat, 0.6);
  const accent = hslHex(h2, Math.min(1, sat + 0.12), 0.72);
  const secondary = hslHex(h3, sat * 0.85, 0.55);
  const background = hslHex((hue + 15) % 360, sat * 0.5, 0.07);
  return {
    background,
    primary,
    secondary,
    accent,
    swatches: [primary, accent, secondary],
    coverArtUrl: null,
  };
}

function hslHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  const to255 = (x: number): number => Math.round(x * 255);
  return `#${((to255(f(0)) << 16) | (to255(f(8)) << 8) | to255(f(4))).toString(16).padStart(6, '0')}`;
}

/**
 * Extract a palette from ID3v2-embedded cover art (APIC frame).
 * Returns null when the file has no usable art — scenes keep defaults.
 */
export async function extractPalette(bytes: ArrayBuffer): Promise<Palette | null> {
  const art = extractApic(new DataView(bytes));
  if (!art) return null;

  const url = URL.createObjectURL(art);
  try {
    const v = await Vibrant.from(url).getPalette();
    const hex = (s: { hex: string } | null | undefined): string | null => s?.hex ?? null;
    const primary = hex(v.Vibrant) ?? hex(v.LightVibrant) ?? hex(v.Muted);
    if (!primary) return null;

    const background = darken(hex(v.DarkMuted) ?? hex(v.DarkVibrant) ?? '#0a0a18', 0.65);
    const secondary = hex(v.Muted) ?? hex(v.DarkVibrant) ?? primary;
    const accent = hex(v.LightVibrant) ?? hex(v.LightMuted) ?? primary;
    const swatches = [
      hex(v.Vibrant),
      hex(v.LightVibrant),
      hex(v.Muted),
      hex(v.LightMuted),
      hex(v.DarkVibrant),
      hex(v.DarkMuted),
    ].filter((h): h is string => h !== null);

    return { background, primary, secondary, accent, swatches, coverArtUrl: url };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

/** Minimal ID3v2.3/2.4 APIC frame reader. */
function extractApic(view: DataView): Blob | null {
  if (view.byteLength < 10) return null;
  if (str(view, 0, 3) !== 'ID3') return null;
  const version = view.getUint8(3);
  const tagSize = syncsafe(view, 6) + 10;

  let offset = 10;
  while (offset + 10 < Math.min(tagSize, view.byteLength)) {
    const id = str(view, offset, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize =
      version === 4 ? syncsafe(view, offset + 4) : view.getUint32(offset + 4, false);
    if (frameSize <= 0 || offset + 10 + frameSize > view.byteLength) break;

    if (id === 'APIC') {
      let p = offset + 10;
      const end = p + frameSize;
      const encoding = view.getUint8(p);
      p += 1;
      const mimeStart = p;
      while (p < end && view.getUint8(p) !== 0) p++;
      const mime = str(view, mimeStart, p - mimeStart) || 'image/jpeg';
      p += 1; // null terminator
      p += 1; // picture type
      // Description: UTF-16 encodings terminate with a double null.
      if (encoding === 1 || encoding === 2) {
        while (p + 1 < end && (view.getUint8(p) !== 0 || view.getUint8(p + 1) !== 0)) p += 2;
        p += 2;
      } else {
        while (p < end && view.getUint8(p) !== 0) p++;
        p += 1;
      }
      if (p >= end) return null;
      return new Blob([view.buffer.slice(p, end) as ArrayBuffer], { type: mime });
    }
    offset += 10 + frameSize;
  }
  return null;
}

function str(view: DataView, start: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(start + i));
  return s;
}

function syncsafe(view: DataView, offset: number): number {
  return (
    ((view.getUint8(offset) & 0x7f) << 21) |
    ((view.getUint8(offset + 1) & 0x7f) << 14) |
    ((view.getUint8(offset + 2) & 0x7f) << 7) |
    (view.getUint8(offset + 3) & 0x7f)
  );
}

function darken(hexColor: string, amount: number): string {
  const n = parseInt(hexColor.slice(1), 16);
  const f = 1 - amount;
  const r = Math.round(((n >> 16) & 0xff) * f);
  const g = Math.round(((n >> 8) & 0xff) * f);
  const b = Math.round((n & 0xff) * f);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
