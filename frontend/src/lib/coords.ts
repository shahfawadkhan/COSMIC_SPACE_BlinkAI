// Coordinate helpers. Always show RA and Dec, sexagesimal AND degrees.

const MINUS = "−";

export function formatRA(raDeg: number, decimals = 2): string {
  let total = ((((raDeg % 360) + 360) % 360) / 15) * 3600;
  total = Math.round(total * 10 ** decimals) / 10 ** decimals;
  if (total >= 86400) total -= 86400;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total - h * 3600) / 60);
  const s = total - h * 3600 - m * 60;
  return `${pad(h)}h ${pad(m)}m ${s.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, "0")}s`;
}

export function formatDec(decDeg: number, decimals = 1): string {
  const sign = decDeg < 0 ? MINUS : "+";
  const total = Math.round(Math.abs(decDeg) * 3600 * 10 ** decimals) / 10 ** decimals;
  const d = Math.floor(total / 3600);
  const m = Math.floor((total - d * 3600) / 60);
  const s = total - d * 3600 - m * 60;
  return `${sign}${pad(d)}° ${pad(m)}′ ${s.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, "0")}″`;
}

export function formatDeg(v: number, decimals = 5): string {
  const t = `${Math.abs(v).toFixed(decimals)}°`;
  return v < 0 ? MINUS + t : t;
}

export function raLabel(ra: number): string {
  return `RA ${formatRA(ra)} (${formatDeg(((ra % 360) + 360) % 360)})`;
}

export function decLabel(dec: number): string {
  return `Dec ${formatDec(dec)} (${formatDeg(dec)})`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function julianYearNow(): number {
  const jd = Date.now() / 86400000 + 2440587.5;
  return 2000 + (jd - 2451545.0) / 365.25;
}

/** Linear proper-motion shift; pmra is pmra* (already × cos dec), mas/yr. */
export function propagate(ra: number, dec: number, pmra: number, pmdec: number, fromEpoch: number, toEpoch = julianYearNow()): [number, number] {
  const dt = toEpoch - fromEpoch;
  const cosd = Math.cos((dec * Math.PI) / 180);
  const dDec = (pmdec * dt) / 3.6e6;
  const dRa = cosd > 1e-9 ? (pmra * dt) / 3.6e6 / cosd : 0;
  return [(((ra + dRa) % 360) + 360) % 360, Math.max(-90, Math.min(90, dec + dDec))];
}

export const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function mjdToDate(mjd: number): Date {
  return new Date((mjd - 40587) * 86400000);
}

export function fmtDate(mjd: number): string {
  return mjdToDate(mjd).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- TAN grid (north up, east left)
export interface GridWcs {
  crval1: number;
  crval2: number;
  crpix1: number;
  crpix2: number;
  cdelt1: number;
  cdelt2: number;
}

export function gridWcs(w: Record<string, number | string>): GridWcs {
  return {
    crval1: Number(w.CRVAL1),
    crval2: Number(w.CRVAL2),
    crpix1: Number(w.CRPIX1),
    crpix2: Number(w.CRPIX2),
    cdelt1: Number(w.CDELT1),
    cdelt2: Number(w.CDELT2),
  };
}

const D2R = Math.PI / 180;

/** Grid pixel (0-based, y up = north) -> RA/Dec (deg). */
export function pixToWorld(w: GridWcs, x: number, y: number): [number, number] {
  const xi = (x + 1 - w.crpix1) * w.cdelt1 * D2R;
  const eta = (y + 1 - w.crpix2) * w.cdelt2 * D2R;
  const a0 = w.crval1 * D2R;
  const d0 = w.crval2 * D2R;
  // TAN: xi is east-positive; the negative CDELT1 is what puts east on the left.
  const den = Math.cos(d0) - eta * Math.sin(d0);
  const ra = a0 + Math.atan2(xi, den);
  const dec = Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.sqrt(xi * xi + den * den));
  return [(((ra / D2R) % 360) + 360) % 360, dec / D2R];
}

/** RA/Dec -> grid pixel (0-based). */
export function worldToPix(w: GridWcs, ra: number, dec: number): [number, number] {
  const a = ra * D2R;
  const d = dec * D2R;
  const a0 = w.crval1 * D2R;
  const d0 = w.crval2 * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  const xi = (Math.cos(d) * Math.sin(a - a0)) / cosc;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc;
  return [xi / D2R / w.cdelt1 + w.crpix1 - 1, eta / D2R / w.cdelt2 + w.crpix2 - 1];
}

// ---------------------------------------------------------------- typed coordinates
export interface Parsed {
  deg: number | null;
  error: string | null;
  sexagesimal: boolean;
}

/** Unify the many ways people type signs, degrees and primes. */
export function normalizeCoordText(t: string): string {
  return t
    .replace(/[\u2212\u2013\u2014]/g, "-")
    .replace(/[\u00b0\u00ba]/g, "d")
    .replace(/[\u2032\u02b9\u2019']{2}|[\u2033\u02ba"]/g, "s")
    .replace(/[\u2032\u02b9\u2019']/g, "m")
    .replace(/,/g, " ")
    .trim();
}

const NUM = String.raw`(\d+(?:\.\d*)?|\.\d+)`;

function sexParts(t: string): number[] | null {
  // "08h55m10.83s", "08:55:10.83", "08 55 10.83", "-07d14m42.5s", "8h55.2m"
  const clean = t.replace(/^[+-]/, "").trim();
  const re = new RegExp(String.raw`^${NUM}\s*[hd:\s]\s*${NUM}?\s*[m:\s]?\s*${NUM}?\s*s?$`, "i");
  const m = clean.match(re);
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].filter((x) => x !== undefined).map(Number);
  return parts.length >= 2 || /[hd:]/i.test(clean) ? parts : null;
}

export function parseRAInput(text: string): Parsed {
  const t = normalizeCoordText(text);
  if (!t) return { deg: null, error: null, sexagesimal: false };
  if (/^[+-]?\d+(\.\d*)?$/.test(t) || /^\.\d+$/.test(t)) {
    const v = Number(t);
    if (v < 0 || v >= 360) return { deg: null, error: "RA in degrees must be 0 to 360", sexagesimal: false };
    return { deg: v, error: null, sexagesimal: false };
  }
  if (/^[+-]/.test(t)) return { deg: null, error: "RA cannot be negative", sexagesimal: true };
  const p = sexParts(t);
  if (!p) return { deg: null, error: "Use 08h 55m 10.8s, 08:55:10.8 or degrees", sexagesimal: true };
  const [h, m = 0, s = 0] = p;
  if (h >= 24) return { deg: null, error: "Hours must be 0 to 23", sexagesimal: true };
  if (m >= 60 || s >= 60) return { deg: null, error: "Minutes and seconds must be below 60", sexagesimal: true };
  return { deg: (h + m / 60 + s / 3600) * 15, error: null, sexagesimal: true };
}

export function parseDecInput(text: string): Parsed {
  const t = normalizeCoordText(text);
  if (!t) return { deg: null, error: null, sexagesimal: false };
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) {
    const v = Number(t);
    if (v < -90 || v > 90) return { deg: null, error: "Dec must be between \u221290\u00b0 and +90\u00b0", sexagesimal: false };
    return { deg: v, error: null, sexagesimal: false };
  }
  const p = sexParts(t);
  if (!p) return { deg: null, error: "Use \u221207\u00b0 14\u2032 42.5\u2033, -07:14:42.5 or degrees", sexagesimal: true };
  if (!/^[+-]/.test(t)) return { deg: null, error: "Add + or \u2212 in front (e.g. \u221207 14 42.5)", sexagesimal: true };
  const [d, m = 0, s = 0] = p;
  if (m >= 60 || s >= 60) return { deg: null, error: "Minutes and seconds must be below 60", sexagesimal: true };
  const v = (d + m / 60 + s / 3600) * (t.startsWith("-") ? -1 : 1);
  if (v < -90 || v > 90) return { deg: null, error: "Dec must be between \u221290\u00b0 and +90\u00b0", sexagesimal: true };
  return { deg: v, error: null, sexagesimal: true };
}

/** "08 55 10.8 -07 14 42" pasted into one box -> ["08 55 10.8", "-07 14 42"], or null. */
export function splitCoordPair(text: string): [string, string] | null {
  const t = normalizeCoordText(text);
  const tokens = t.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    // "08:55:10.8-07:14:42" glued together
    const m = t.match(/^(.+?\d)([+-]\d.*)$/);
    return m && parseRAInput(m[1]).deg !== null && parseDecInput(m[2]).deg !== null ? [m[1], m[2]] : null;
  }
  const ok: number[] = [];
  for (let k = 1; k < tokens.length; k++) {
    const ra = tokens.slice(0, k).join(" ");
    const dec = tokens.slice(k).join(" ");
    if (parseRAInput(ra).deg !== null && parseDecInput(dec).deg !== null) ok.push(k);
  }
  if (!ok.length) return null;
  const signed = ok.find((k) => /^[+-]/.test(tokens[k]));
  const k = signed ?? (ok.length === 1 ? ok[0] : Math.floor(tokens.length / 2));
  if (!ok.includes(k)) return null;
  return [tokens.slice(0, k).join(" "), tokens.slice(k).join(" ")];
}
