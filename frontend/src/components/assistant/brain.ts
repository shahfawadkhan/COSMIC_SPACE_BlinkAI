// Cosmo's scripted brain: keyword answers built from the LIVE app state, plus commands.
// Anything it does not recognise goes to the SPHEREx AI service (via our backend).

import type { Identify, Manifest, TargetInfo } from "../../api/client";
import { decLabel, formatDec, formatRA, parseDecInput, parseRAInput, raLabel, splitCoordPair } from "../../lib/coords";
import type { LiveView } from "../../state/assistantStore";
import type { Mode } from "../../state/view";
import type { Phase, Target } from "../../state/workspace";

export type Effect =
  | { type: "loadTarget"; target: TargetInfo }
  | { type: "loadQuery"; query: string }
  | { type: "loadCoords"; ra: number; dec: number }
  | { type: "mode"; mode: Mode }
  | { type: "band"; band: string }
  | { type: "navigate"; to: string };

export interface Chip {
  label: string;
  effect?: Effect;
  ask?: string;
}

export interface Reply {
  text: string;
  chips?: Chip[];
  effect?: Effect;
}

export interface Snapshot {
  target: Target | null;
  phase: Phase;
  manifest: Manifest | null;
  identity: Identify | null;
  live: LiveView | null;
  targets: TargetInfo[];
  path: string;
}

export const SUGGESTIONS = ["Show me WISE 0855", "How do I spot a moving object?", "What do the red marks mean?", "What am I looking at?"];

const norm = (s: string) => s.toLowerCase().replace(/[\u2019']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const ALIASES: Record<string, string[]> = {
  wise0855: ["wise 0855", "wise0855", "wise j0855", "wise j085510", "0855", "coldest brown dwarf"],
  barnard: ["barnard", "barnards star", "barnards"],
  epsindib: ["eps ind b", "epsilon indi b", "epsilon indi", "eps ind", "epsindi"],
  rwaur: ["rw aur", "rw aurigae", "rwaur"],
  rdra: ["r dra", "r draconis", "rdra"],
};

function findTarget(text: string, targets: TargetInfo[]): TargetInfo | null {
  const n = ` ${norm(text)} `;
  for (const t of targets) {
    const keys = [...(ALIASES[t.id] ?? []), norm(t.name)];
    if (keys.some((k) => n.includes(` ${norm(k)} `) || n.includes(` ${norm(k)}`))) return t;
  }
  return null;
}

/** "go to 133.79 -7.24", "show 08 55 10.8 -07 14 42" → degrees, or null. */
export function findCoords(text: string): { ra: number; dec: number } | null {
  const tail = text.replace(/^.*?(?=[0-9])/, "").replace(/[?!.]+$/, "").trim();
  if (!tail) return null;
  const pair = splitCoordPair(tail);
  if (!pair) return null;
  const ra = parseRAInput(pair[0]).deg;
  const dec = parseDecInput(pair[1]).deg;
  return ra !== null && dec !== null ? { ra, dec } : null;
}

function epochsLine(s: Snapshot): string | null {
  const v = s.live?.view;
  if (!v) return null;
  const eps = v.epochs.map((e) => e.label).join(", ");
  return `${v.epochs.length} survey passes: ${eps}`;
}

function moversLines(s: Snapshot): string[] {
  const m = s.live?.movers;
  if (!m) return [];
  return m.pairs.slice(0, 5).map((p) => {
    const named = p.identified !== false && !!p.name && !p.name.startsWith("Unidentified");
    const cat = p.expected_shift_arcsec != null ? `, catalogue ${p.expected_shift_arcsec.toFixed(1)}″` : "";
    return `- ${named ? `**${p.name}**` : "**Unidentified candidate – needs further scientific investigation (not a claim of Planet X)**"}: moved ${p.shift_arcsec.toFixed(1)}″ toward PA ${p.pa_deg.toFixed(0)}°${cat}${p.matches_catalogue ? " ✓ matches the catalogue" : ""}`;
  });
}

function whereAmI(s: Snapshot): Reply {
  const t = s.target;
  if (!t) {
    return {
      text: "Nothing is loaded yet. Pick a test object or type a name or coordinates and I will open its SPHEREx images.",
      chips: s.targets.slice(0, 3).map((x) => ({ label: `Show ${x.name}`, effect: { type: "loadTarget", target: x } })),
    };
  }
  if (s.phase === "building" || s.phase === "resolving") {
    return { text: `I'm fetching SPHEREx images of **${t.name ?? "this position"}** from NASA IRSA right now (${raLabel(t.ra)}, ${decLabel(t.dec)}). The first look at a field takes up to a minute; after that it is instant.` };
  }
  const v = s.live?.view;
  const lines = [`You are looking at **${t.name ?? "a sky position"}**: ${raLabel(t.ra)}, ${decLabel(t.dec)}.`];
  if (s.manifest) lines.push(`The field is ${s.manifest.grid.fov_arcmin}′ across, built from ${s.manifest.counts.kept} real SPHEREx exposures (NASA IRSA, ${s.manifest.collections.join(", ")}).`);
  const ep = epochsLine(s);
  if (ep) lines.push(`It has ${ep}.`);
  if (v && s.live) {
    const A = v.epochs[s.live.a];
    const B = v.epochs[s.live.b];
    const band = s.live.band === "all" ? "all six detectors combined" : `detector ${s.live.band}`;
    lines.push(`You are in **${s.live.mode === "diff" ? "Difference" : s.live.mode === "side" ? "Side by side" : s.live.mode[0].toUpperCase() + s.live.mode.slice(1)}** mode comparing A = ${A?.label ?? "?"} with B = ${B?.label ?? "?"}, using ${band}.`);
  }
  if (t.pmra || t.pmdec) lines.push(`Its catalogue proper motion is ${(Math.hypot(t.pmra ?? 0, t.pmdec ?? 0) / 1000).toFixed(2)}″ per year; the teal dashed circle shows where the catalogue puts it on the shown date.`);
  if (s.identity?.label) lines.push(s.identity.label + ".");
  const mv = moversLines(s);
  if (mv.length) lines.push(`\nMover candidates between A and B:\n${mv.join("\n")}`);
  else if (s.live?.movers) lines.push("No mover above 5σ between A and B in this band.");
  return {
    text: lines.join("\n"),
    chips: s.path.startsWith("/explorer") ? [{ label: "Switch to Difference", effect: { type: "mode", mode: "diff" } }, { label: "Blink A ↔ B", effect: { type: "mode", mode: "blink" } }] : [{ label: "Open Blink Explorer", effect: { type: "navigate", to: "/explorer" } }],
  };
}

function howToSpot(s: Snapshot): Reply {
  const ep = epochsLine(s);
  return {
    text: [
      "Things that move change place between survey passes; stars stay put. To catch them:",
      "1. Press **2** for **Blink**: the view flips between epoch A and B. Anything that jumps is moving.",
      "2. Press **5** for **Difference** (B − A): red = brighter now, blue = fainter. A mover makes a blue–red pair; ±3σ hides the noise.",
      "3. Try one detector at a time (chips 1–6): cold brown dwarfs show best at 4–5 µm (detectors 5–6).",
      "4. Rings mark candidates: dashed = position in A, solid + arrow = position in B. Click a ring to keep it in the Discovery Log.",
      ep ? `\nYour current field has ${ep}. Click a pass on the timeline for B, shift-click for A.` : "",
    ].join("\n"),
    chips: [{ label: "Switch to Blink", effect: { type: "mode", mode: "blink" } }, { label: "Switch to Difference", effect: { type: "mode", mode: "diff" } }, { label: "Show me Barnard's Star", ask: "Show me Barnard's Star" }],
  };
}

function redMarks(s: Snapshot): Reply {
  const mv = moversLines(s);
  return {
    text: [
      "The rings are **mover candidates**, found by subtracting two epochs and pairing a blue (old place) with a red (new place) peak:",
      "- **Red ring** = matched to a known object in SIMBAD (within 8″) or Gaia DR3 (6″), with its catalogue motion moved to both dates. ✓ means the measured and catalogue motion agree within 3″.",
      "- **Orange ring** = *Unidentified candidate – needs further scientific investigation. Not a claim of Planet X.* No catalogued object there; check it by eye first. To see whether we *could* detect a Planet X, use the **Planet X Lab** (/planetx), which only uses SIMULATED test objects.",
      "- Dashed circle = where it was in A; solid circle + arrow = where it is in B.",
      "They are candidates, **not discoveries**.",
      mv.length ? `\nIn your current view:\n${mv.join("\n")}` : s.live?.movers ? "\nThere is no ring in your current view (nothing moved above 5σ in this band)." : "",
    ].join("\n"),
  };
}

const MODE_WORDS: [RegExp, Mode][] = [
  [/\bdifference|\bsubtract|\bdiff\b/, "diff"],
  [/\bblink/, "blink"],
  [/\bswipe/, "swipe"],
  [/side ?by ?side/, "side"],
  [/\bsingle\b/, "single"],
];

export function think(input: string, s: Snapshot): Reply | null {
  const q = input.trim();
  const n = norm(q);
  if (!n) return null;

  // commands: open a target or coordinates
  const wantsOpen = /^(show|open|go|goto|take|load|find|look|view|display|point|center|centre|build)\b/.test(n) || /\b(show me|go to|take me to|open)\b/.test(n);
  const coords = findCoords(q);
  if (coords && (wantsOpen || /^[\d+\-−. :hmsd°′″'"]+$/i.test(q))) {
    return {
      text: `Opening **RA ${formatRA(coords.ra)}, Dec ${formatDec(coords.dec)}** (${coords.ra.toFixed(4)}°, ${coords.dec.toFixed(4)}°). I'll fetch the SPHEREx images and ask SIMBAD and Gaia what is there.`,
      effect: { type: "loadCoords", ...coords },
    };
  }
  const tgt = findTarget(q, s.targets);
  if (tgt && (wantsOpen || n.split(" ").length <= 4)) {
    return {
      text: `Opening **${tgt.name}**: ${tgt.today.label}. ${tgt.note}${tgt.kind === "moving" ? " Press **2** to blink and watch it move." : ""}`,
      effect: { type: "loadTarget", target: tgt },
    };
  }
  const m = q.match(/^(?:please\s+)?(?:show(?: me)?|open|go to|take me to|find|load)\s+(.{2,60}?)[?.!]*$/i);
  if (m && !/\b(how|what|why|moving|object|mark|ring|difference|blink)\b/i.test(m[1])) {
    return { text: `Looking up **${m[1]}** in CDS Sesame and SIMBAD, then fetching its SPHEREx images…`, effect: { type: "loadQuery", query: m[1] } };
  }

  // mode / band switches
  if (/\b(switch|change|use|turn|set|go)\b.*\b(mode|view)?\b/.test(n) || /^(blink|difference|swipe|side by side|single)( mode)?$/.test(n)) {
    for (const [re, mode] of MODE_WORDS) if (re.test(n)) return { text: `Switched to **${mode === "diff" ? "Difference" : mode === "side" ? "Side by side" : mode[0].toUpperCase() + mode.slice(1)}** mode.`, effect: { type: "mode", mode } };
  }
  const det = n.match(/\b(?:detector|band)\s*([1-6])\b/);
  if (det && /\b(switch|show|use|set|go|change)\b/.test(n)) return { text: `Showing **detector ${det[1]}** only (like with like).`, effect: { type: "band", band: det[1] } };

  // questions about the app and the live view
  if (/what am i (looking|seeing)|what is this|where am i|what s on (the )?screen|describe (this|the view)|current (view|target)/.test(n)) return whereAmI(s);
  if (/(spot|find|see|detect|catch).*(mov|motion)|how .*blink|moving object/.test(n)) return howToSpot(s);
  if (/red (mark|ring|circle)|orange (ring|circle)|what .*(rings?|circles?|marks?) mean|dashed/.test(n)) return redMarks(s);
  if (/\b(movers?|named)\b/.test(n) && s.live?.movers) return redMarks(s);
  if (/\bplanet (x|nine|9)\b/.test(n)) {
    return {
      text: "There is **no Planet X (Planet Nine) in any archive**: it is a hypothesis (Batygin & Brown 2016). So I never call anything Planet X. The Planet X Lab adds a clearly labelled **SIMULATED** slow, faint, red mover to real frames to test whether our detector would find one. A real unexplained mover is labelled *Unidentified candidate – needs further scientific investigation*.",
    };
  }
  if (/^(help|what can you do|who are you|hello|hi|hey)\b/.test(n)) {
    return {
      text: "Hi, I'm **Cosmo** 🤖, a **scripted helper** for this app: I know what is on your screen and I can open targets (\"show Barnard's Star\"), coordinates (\"go to 133.79 -7.24\") and switch views (\"switch to difference\"). Open questions about SPHEREx and astronomy go to the **SPHEREx AI** service when it is connected.",
      chips: SUGGESTIONS.map((x) => ({ label: x, ask: x })),
    };
  }
  return null; // not scripted: ask the SPHEREx AI
}

/** Short description of the live state, sent (clearly marked) with AI questions. */
export function contextFor(s: Snapshot): string {
  const parts: string[] = [];
  if (s.target) parts.push(`target ${s.target.name ?? "unnamed position"} at RA ${s.target.ra.toFixed(5)} deg, Dec ${s.target.dec.toFixed(5)} deg`);
  if (s.manifest) parts.push(`${s.manifest.grid.fov_arcmin} arcmin SPHEREx field from ${s.manifest.counts.kept} exposures`);
  const ep = epochsLine(s);
  if (ep) parts.push(ep);
  if (s.live) parts.push(`viewing mode ${s.live.mode}, band ${s.live.band}`);
  const mv = s.live?.movers?.pairs.slice(0, 4).map((p) => `${p.name ?? "unidentified"} moved ${p.shift_arcsec.toFixed(1)} arcsec`);
  if (mv?.length) parts.push(`mover candidates: ${mv.join("; ")}`);
  if (s.identity?.label) parts.push(s.identity.label);
  return parts.join("; ");
}
