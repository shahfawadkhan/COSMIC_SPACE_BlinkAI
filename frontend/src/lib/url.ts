import type { Target } from "../state/workspace";

export interface ExplorerParams {
  ra: number;
  dec: number;
  fov?: number;
  name?: string | null;
  pmra?: number | null;
  pmdec?: number | null;
  epoch?: number | null;
  auto?: boolean;
  embed?: boolean;
}

export function explorerPath(p: ExplorerParams): string {
  const sp = new URLSearchParams();
  sp.set("ra", p.ra.toFixed(6));
  sp.set("dec", p.dec.toFixed(6));
  if (p.fov) sp.set("fov", String(p.fov));
  if (p.name) sp.set("name", p.name);
  if (p.pmra || p.pmdec) {
    sp.set("pmra", String(p.pmra ?? 0));
    sp.set("pmdec", String(p.pmdec ?? 0));
    if (p.epoch) sp.set("epoch", String(p.epoch));
  }
  if (p.auto !== false) sp.set("auto", "1");
  if (p.embed) sp.set("embed", "1");
  return `/explorer?${sp.toString()}`;
}

/** Link that rebuilds this field for anyone. Moving targets use the catalogue position +
 * proper motion, so the link still points at the object next year. */
export function shareParams(t: Target, fov: number): ExplorerParams {
  if (t.catRa !== undefined && t.catDec !== undefined && t.epoch && (t.pmra || t.pmdec)) {
    return { ra: t.catRa, dec: t.catDec, pmra: t.pmra, pmdec: t.pmdec, epoch: t.epoch, fov, name: t.name };
  }
  return { ra: t.ra, dec: t.dec, fov, name: t.name };
}

export function shareUrl(t: Target, fov: number): string {
  return window.location.origin + explorerPath(shareParams(t, fov));
}

export function embedCode(t: Target, fov: number): string {
  const src = window.location.origin + explorerPath({ ...shareParams(t, fov), embed: true });
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const title = esc(`SPHEREx blink: ${t.name ?? "sky field"}`);
  return `<iframe src="${esc(src)}" width="900" height="640" style="border:0" title="${title}" loading="lazy"></iframe>`;
}

/** Read /explorer?ra=&dec=&fov=&name=&pmra=&pmdec=&epoch=&auto=1 */
export function readExplorerParams(sp: URLSearchParams): (ExplorerParams & { hasPm: boolean }) | null {
  const ra = parseFloat(sp.get("ra") ?? "");
  const dec = parseFloat(sp.get("dec") ?? "");
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || dec < -90 || dec > 90) return null;
  const num = (k: string) => {
    const v = parseFloat(sp.get(k) ?? "");
    return Number.isFinite(v) ? v : null;
  };
  const pmra = num("pmra");
  const pmdec = num("pmdec");
  const hasPm = !!(pmra || pmdec);
  return {
    ra: ((ra % 360) + 360) % 360,
    dec,
    fov: num("fov") ?? undefined,
    name: sp.get("name"),
    pmra,
    pmdec,
    epoch: num("epoch") ?? (hasPm ? 2000 : null),
    auto: sp.get("auto") === "1" || sp.get("auto") === "true",
    embed: sp.get("embed") === "1",
    hasPm,
  };
}
