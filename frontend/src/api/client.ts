import { readSettings } from "../state/settings";
// Typed client for the COSMIC backend (FastAPI on :8000, proxied at /api).

export interface Coords {
  ra: number;
  dec: number;
  ra_hms: string;
  dec_dms: string;
  label: string;
}

export interface Health {
  status: string;
  code_version: string;
  redis: "connected" | "disabled" | "down";
  services_down: Record<string, unknown>;
}

export interface TargetInfo {
  id: string;
  name: string;
  simbad_name: string;
  kind: "moving" | "variable";
  ra: number;
  dec: number;
  epoch: number;
  pmra: number;
  pmdec: number;
  fov_arcmin: number;
  note: string;
  catalog: Coords;
  today: Coords;
  pm_total_arcsec_yr: number;
  shift_since_epoch_arcsec: number;
}

export interface ResolveResult {
  query: string;
  name: string | null;
  main_id?: string | null;
  otype?: string | null;
  target_id?: string;
  ra: number;
  dec: number;
  catalog_ra?: number;
  catalog_dec?: number;
  pmra: number | null;
  pmdec: number | null;
  epoch: number | null;
  kind: string;
  fov_arcmin?: number;
  source: string;
  note?: string;
  coords: Coords;
}

export interface Frame {
  index: number;
  epoch: number;
  detector: number;
  obs_id: string;
  planning_period?: string;
  mjd: number;
  date_obs?: string;
  wavelength_um: number | null;
  bandwidth_um: number | null;
  finite_fraction: number;
  flags_at_target: string[];
  psf_fwhm_arcsec?: number | null;
  file_name?: string;
  url: string;
}

export interface Manifest {
  set_id: string;
  source: string;
  collections: string[];
  created: string;
  request: { ra: number; dec: number; fov_arcmin: number; upsample: number; max_frames: number };
  center: Coords;
  grid: { n: number; pix_arcsec: number; fov_arcmin: number; upsample: number; wcs: Record<string, number | string> };
  epochs: { index: number; label: string; n_frames: number; detectors_used: number[]; missing_detectors: number[] }[];
  frames: Frame[];
  skipped: { obs_id: string; detector: number; mjd: number; reason: string }[];
  complete: boolean;
  counts: Record<string, number>;
  download: { bytes: number };
  timings_s: Record<string, number>;
}

export type Stage = "queued" | "searching" | "downloading" | "reprojecting" | "rendering" | "done";

export interface SetStatus {
  set_id: string;
  job_id: string;
  state: "queued" | "running" | "done" | "error";
  stage: Stage;
  progress: { done: number; total: number };
  eta_s: number | null;
  message?: string;
  detail?: Record<string, unknown>;
  error: { code: string; message: string } | null;
  set: Manifest | null;
}

export interface ViewEpoch {
  index: number;
  label: string;
  mjd: number;
  mjd_start: number;
  mjd_end: number;
  date: string | null;
  members: number[];
  n_frames: number;
  detectors: number[];
  wavelength_um: [number, number] | null;
  coverage: number;
  has_data: boolean;
  flags_at_target: string[];
  image_url: string | null;
}

export interface ViewResponse {
  set_id: string;
  source: string;
  band: string;
  group_by: string;
  background: string;
  detectors_used: number[];
  detectors_excluded: number[];
  note: string | null;
  center: Coords;
  grid: { n: number; pix_arcsec: number; fov_arcmin: number; upsample: number };
  display: { vmin: number; vmax: number };
  epochs: ViewEpoch[];
  count: number;
}

export interface MoverEnd {
  x: number;
  y: number;
  ra: number | null;
  dec: number | null;
  sigma: number;
  coords?: Coords;
}

export interface MoverPair {
  from: MoverEnd;
  to: MoverEnd;
  shift_arcsec: number;
  shift_pix: number;
  pa_deg: number;
  significance: number;
  rate_arcsec_per_yr?: number;
  saturated?: boolean;
  method?: string;
  label: string;
  // catalogue cross-match (step 5)
  name?: string;
  identified?: boolean;
  catalogue?: string | null;
  otype?: string | null;
  expected_shift_arcsec?: number | null;
  motion_disagreement_arcsec?: number;
  matches_catalogue?: boolean;
}

export interface MoversResponse {
  set_id: string;
  band: string;
  dt_days: number;
  a: { index: number; label: string; mjd: number; date: string };
  b: { index: number; label: string; mjd: number; date: string };
  pairs: MoverPair[];
  unpaired_new: MoverEnd[];
  unpaired_old: MoverEnd[];
  catalogue_errors?: Record<string, string>;
  note: string;
}

export interface CatalogSource {
  id: string;
  main_id?: string;
  otype?: string | null;
  ra: number;
  dec: number;
  pmra?: number | null;
  pmdec?: number | null;
  mag?: number | null;
  epoch?: number;
  distance_arcsec?: number;
}

export interface ConeResponse {
  source: "gaia" | "simbad";
  provider: string;
  epoch: number;
  count: number;
  sources: CatalogSource[];
}

export interface Identify {
  query: { ra: number; dec: number; radius_arcsec: number; coords: Coords };
  nearest: { name: string; main_id: string; otype: string | null; catalogue: string; distance_arcsec: number; pmra: number | null; pmdec: number | null } | null;
  use_as_name: boolean;
  label: string;
  simbad: CatalogSource[];
  gaia_nearest: CatalogSource | null;
  errors: Record<string, string>;
}

export interface OverlaySource extends CatalogSource {
  pix: [number, number][]; // grid pixel position at each epoch of the view
}

export interface OverlayResponse {
  source: "gaia" | "simbad";
  provider: string;
  epochs: number[];
  count: number;
  truncated: boolean;
  sources: OverlaySource[];
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** Backend chosen at build time (VITE_API_BASE), used when Settings leaves the API base URL empty. */
const BUILD_API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? "").trim();

/** Prefix an /api path with the backend base URL: Settings > API base URL, else the build default,
 * else the same origin (the Vite dev proxy). */
export function apiUrl(path: string): string {
  if (!path.startsWith("/")) return path;
  const base = (readSettings().apiBaseUrl.trim() || BUILD_API_BASE).replace(/\/+$/, "");
  return base + path;
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 30000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const outer = init.signal;
  if (outer) outer.addEventListener("abort", () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(apiUrl(path), { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      if (body === null && res.status >= 500) {
        // No JSON from us: the dev proxy could not reach the backend (or it is restarting).
        throw new ApiError(res.status, "network", "Cannot reach the COSMIC server. Is the backend running on port 8000?");
      }
      const b = (body ?? {}) as { code?: string; message?: string };
      throw new ApiError(res.status, b.code ?? "http_error", b.message ?? `Server error (HTTP ${res.status})`);
    }
    return body as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if ((e as Error).name === "AbortError") {
      if (outer?.aborted) throw e;
      throw new ApiError(0, "timeout", "The server did not answer in time");
    }
    throw new ApiError(0, "network", "Cannot reach the COSMIC server. Is the backend running on port 8000?");
  } finally {
    clearTimeout(timer);
  }
}

const q = (params: Record<string, string | number | boolean | undefined | null>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

export const api = {
  health: (signal?: AbortSignal) => request<Health>("/api/health", { signal }, 8000),
  targets: () => request<{ targets: TargetInfo[] }>("/api/targets"),
  resolve: (text: string, signal?: AbortSignal) =>
    request<ResolveResult>(`/api/resolve?${q({ q: text })}`, { signal }, 15000),
  createSet: (body: { ra: number; dec: number; fov_arcmin: number; upsample?: number; max_frames?: number }, signal?: AbortSignal) =>
    request<{ set_id: string; job_id: string; state: string }>("/api/sets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  getSet: (id: string, signal?: AbortSignal) => request<SetStatus>(`/api/sets/${id}`, { signal }),
  view: (id: string, band: string, groupBy = "epoch", signal?: AbortSignal) =>
    request<ViewResponse>(`/api/sets/${id}/view?${q({ band, group_by: groupBy })}`, { signal }),
  movers: (id: string, a: number, b: number, band: string, signal?: AbortSignal) =>
    request<MoversResponse>(`/api/sets/${id}/movers?${q({ a, b, band })}`, { signal }, 90000),
  identify: (ra: number, dec: number, radiusArcsec = 30, signal?: AbortSignal) =>
    request<Identify>(`/api/identify?${q({ ra: ((ra % 360) + 360) % 360, dec, radius_arcsec: radiusArcsec })}`, { signal }, 60000),
  cone: (p: { ra: number; dec: number; radius_arcsec: number; source: "gaia" | "simbad"; limit?: number }, signal?: AbortSignal) =>
    request<ConeResponse>(`/api/cone?${q({ ...p, ra: ((p.ra % 360) + 360) % 360 })}`, { signal }, 60000),
  overlay: (id: string, source: "gaia" | "simbad", band: string, signal?: AbortSignal) =>
    request<OverlayResponse>(`/api/sets/${id}/overlay?${q({ source, band })}`, { signal }, 90000),
  cacheStats: () => request<Record<string, unknown>>("/api/cache/stats"),
  clearCache: (scope: "renders" | "searches") =>
    request<Record<string, unknown>>(`/api/cache/clear?${q({ scope })}`, { method: "POST" }),
};

export interface ImageParams {
  stretch: string;
  cmap: string;
  pmin: number;
  pmax: number;
  upscale: number;
}

export function imageUrl(baseUrl: string, p: ImageParams): string {
  return `${apiUrl(baseUrl)}&${q({ stretch: p.stretch, cmap: p.cmap, pmin: p.pmin, pmax: p.pmax, upscale: p.upscale })}`;
}

export function combineUrl(setId: string, a: number, b: number, band: string, tail: number, cmap: string, upscale: number): string {
  return apiUrl(`/api/sets/${setId}/combine.png?`) + `${q({ plus: b, minus: a, band, tail, cmap, upscale })}`;
}

// ---------------------------------------------------------------- photometry (AstroAnalytics)
export interface PhotRow {
  mjd: number;
  date: string;
  jyear: number;
  detector: number;
  obs_id: string;
  url: string;
  wavelength_um: number | null;
  bandwidth_um: number | null;
  status: "ok" | "saturated" | "masked" | "outside";
  reason?: string;
  flux_mjy?: number;
  err_mjy?: number;
  snr?: number;
  ra_expected: number;
  dec_expected: number;
  centroid_ra?: number;
  centroid_dec?: number;
  dra_arcsec?: number;
  ddec_arcsec?: number;
  blend?: { id: string; sep_arcsec: number; gmag: number | null }[];
}

export interface PhotResult {
  job_id: string;
  params: { ra: number; dec: number; pm_ra: number; pm_dec: number; epoch: number; aperture_arcsec: number; max_frames: number; set_id: string | null };
  source: string;
  frames_from: string;
  missing_cutouts: number;
  position: Coords;
  units: { flux: string; wavelength: string };
  summary: {
    n_images: number;
    n_measured: number;
    n_saturated: number;
    n_masked: number;
    n_outside: number;
    n_detected: number;
    n_blended: number;
    blend_check: string;
    message: string | null;
    blend_message?: string;
  };
  motion_fit: { n: number; baseline_yr: number; pmra_mas_yr: number; pmra_err_mas_yr: number; pmdec_mas_yr: number; pmdec_err_mas_yr: number; rms_ra_arcsec: number; rms_dec_arcsec: number } | null;
  rows: PhotRow[];
}

export interface PhotStatus {
  job_id: string;
  state: "queued" | "running" | "done" | "error";
  stage?: string;
  progress?: { done: number; total: number };
  message?: string;
  error?: { code: string; message: string } | null;
  result: PhotResult | null;
}

export interface PhotParams {
  ra: number;
  dec: number;
  pm_ra?: number;
  pm_dec?: number;
  epoch?: number;
  aperture_arcsec?: number;
  max_frames?: number;
  set_id?: string | null;
}

export const photometry = {
  get: (p: PhotParams, signal?: AbortSignal) => request<PhotStatus>(`/api/spectrum?${q({ ...p })}`, { signal }, 60000),
  csvUrl: (p: PhotParams) => apiUrl(`/api/spectrum.csv?${q({ ...p })}`),
};

// ---------------------------------------------------------------- Planet X Lab (SIMULATED only)
export interface InjectParams {
  mode: "real" | "synthetic";
  set_id?: string | null;
  start_ra?: number | null;
  start_dec?: number | null;
  distance_au: number;
  rate_arcsec_per_day?: number | null;
  position_angle_deg: number;
  peak_snr: number;
  detectors: number[];
  seed: number;
}

export interface InjectVisit {
  index: number;
  label: string;
  mjd: number;
  date: string | null;
  n_frames: number;
  truth_ra: number;
  truth_dec: number;
  truth_x: number;
  truth_y: number;
  in_field: boolean;
}

export interface InjectPair {
  a: number;
  b: number;
  a_label: string;
  b_label: string;
  dt_days: number;
  expected_shift_arcsec: number;
  tested: boolean;
  recovered: boolean;
  long_baseline: boolean;
  reason?: string;
  other_candidates?: number;
  position_error_arcsec?: number;
  measured_shift_arcsec?: number;
  snr?: number;
  detection?: { from: { x: number; y: number }; to: { x: number; y: number } };
}

export interface InjectSummary {
  n_pairs: number;
  n_tested: number;
  n_recovered: number;
  mean_position_error_arcsec: number | null;
  message: string;
}

export interface InjectResult {
  simulated: true;
  label: string;
  source: "SIMULATED";
  sim_set_id: string | null;
  parent_set_id: string | null;
  params: InjectParams & { t0_mjd: number; rate_auto: boolean; start_ra: number; start_dec: number };
  grid: { n: number; pix_arcsec: number; fov_arcmin: number };
  start: Coords;
  truth: { frame: number; mjd: number; ra: number; dec: number; x: number; y: number; detector: number; injected: boolean }[];
  visits: InjectVisit[];
  pairs: InjectPair[];
  band: string;
  summary: InjectSummary;
}

export interface SweepRow {
  distance_au: number;
  peak_snr: number;
  rate_arcsec_per_day: number;
  n_tested: number;
  n_recovered: number;
  mean_position_error_arcsec: number | null;
  message: string;
}

export interface SweepResult {
  simulated: true;
  label: string;
  snr_values: number[];
  distances_au: number[];
  rows: SweepRow[];
}

const postJson = <T,>(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal) =>
  request<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal }, timeoutMs);

export const planetx = {
  inject: (p: InjectParams, signal?: AbortSignal) => postJson<InjectResult>("/api/inject", p, 180000, signal),
  sweep: (p: InjectParams, signal?: AbortSignal) => postJson<SweepResult>("/api/inject/sweep", p, 600000, signal),
};
