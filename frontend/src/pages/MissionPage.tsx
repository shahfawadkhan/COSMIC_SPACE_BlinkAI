import { Link } from "react-router-dom";
import { DETECTOR_UM } from "../components/Timeline";
import { Panel, ProvChip } from "../components/ui";

const BAND_HEX: Record<number, string> = { 1: "#6aa7ff", 2: "#26b3b3", 3: "#5fae3c", 4: "#d4b21c", 5: "#f09a4a", 6: "#ef6b73" };
const FACTS: [string, string][] = [
  ["Launched", "11 March 2025"],
  ["Survey", "Whole sky every ~6 months (survey passes); data from May 2025"],
  ["Wavelengths", "0.75 – 5.0 µm, near-infrared"],
  ["Spectral channels", "102 (linear variable filters)"],
  ["Pixels", "6.2″ (arc-seconds) on the sky"],
  ["Detectors", "6 arrays, each covering one slice of the spectrum"],
  ["Archive", "NASA/IPAC Infrared Science Archive (IRSA), collection spherex_dr1"],
];

function DetectorBar() {
  const W = 900;
  const x = (um: number) => 20 + ((um - 0.7) / (5.05 - 0.7)) * (W - 40);
  const ticks = [0.75, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
  const molecules: [number, string][] = [
    [1.4, "H₂O"],
    [1.9, "H₂O"],
    [2.7, "H₂O"],
    [3.05, "H₂O ice"],
    [3.3, "CH₄"],
    [4.27, "CO₂"],
    [4.67, "CO"],
  ];
  return (
    <svg viewBox={`0 0 ${W} 130`} className="w-full" role="img" aria-label="The six SPHEREx detectors across 0.75 to 5 micrometres">
      {[1, 2, 3, 4, 5, 6].map((d) => {
        const [a, b] = DETECTOR_UM[d];
        return (
          <g key={d}>
            <rect x={x(a)} y={34} width={x(b) - x(a)} height={30} fill={BAND_HEX[d]} opacity={0.85} rx={3} />
            <text x={(x(a) + x(b)) / 2} y={54} textAnchor="middle" fontSize="13" fontWeight="700" fill="#0f1923">
              D{d}
            </text>
            <text x={(x(a) + x(b)) / 2} y={26} textAnchor="middle" fontSize="11" fill="var(--ink-2)" fontFamily="Source Code Pro, monospace">
              {a}–{b}
            </text>
          </g>
        );
      })}
      <line x1={x(0.75)} x2={x(5)} y1={72} y2={72} stroke="var(--line-strong)" />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={72} y2={78} stroke="var(--line-strong)" />
          <text x={x(t)} y={92} textAnchor="middle" fontSize="11" fill="var(--ink-3)" fontFamily="Source Code Pro, monospace">
            {t}
          </text>
        </g>
      ))}
      <text x={W / 2} y={108} textAnchor="middle" fontSize="11" fill="var(--ink-3)">
        wavelength (µm)
      </text>
      {molecules.map(([um, name], i) => (
        <text key={i} x={x(um)} y={124} textAnchor="middle" fontSize="10.5" fill="var(--accent)">
          ▲ {name}
        </text>
      ))}
    </svg>
  );
}

export default function MissionPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1100px] space-y-5 px-6 py-8">
        <div>
          <h1 className="h1 m-0" style={{ fontSize: 32 }}>
            SPHEREx Mission
          </h1>
          <p className="mt-2 text-ink2" style={{ fontSize: 16, maxWidth: 760 }}>
            NASA&rsquo;s SPHEREx (Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer) maps the entire sky in 102 colours of near-infrared light. It is sensitive to molecules such as water, carbon dioxide and carbon monoxide, and because it maps the sky again every six months, things that move or change can be found by comparing passes.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <Panel title="Mission facts">
            <dl className="m-0">
              {FACTS.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 border-t border-line py-1.5 first:border-t-0">
                  <dt className="text-ink3">{k}</dt>
                  <dd className="m-0 text-right">{v}</dd>
                </div>
              ))}
            </dl>
          </Panel>
          <Panel title="The six detectors">
            <DetectorBar />
            <p className="mb-0 mt-1 text-ink2" style={{ fontSize: 13 }}>
              Each detector carries a linear variable filter: the wavelength changes across the array, so one exposure samples a different wavelength at each position. Comparing two dates is only fair within one detector, which is why COSMIC lets you pick a detector and, in the all-detector view, uses the same detector mix for every epoch.
            </p>
          </Panel>
        </div>

        <Panel title="How COSMIC works">
          <ol className="m-0 space-y-1.5 pl-5 text-ink2">
            <li>
              <b className="text-ink">Search.</b> Ask IRSA (SIA2, spherex_dr1) for every Level-2 image whose footprint contains your position. Moving targets are first shifted to today with their proper motion.
            </li>
            <li>
              <b className="text-ink">Select and download.</b> Pick up to 40 images spread over all survey passes and all six detectors; download only the small cutout needed (field × 1.2), stopping before the large PSF table.
            </li>
            <li>
              <b className="text-ink">Clean and align.</b> Subtract the zodiacal light (IMAGE − ZODI), mask bad pixels from the FLAGS plane, reproject everything onto one north-up grid.
            </li>
            <li>
              <b className="text-ink">Compare.</b> Stack each survey pass, blink, swipe or subtract passes. Difference peaks that pair up into ± dipoles become mover candidates; SIMBAD and Gaia DR3 (moved to each date) name them.
            </li>
            <li>
              <b className="text-ink">Measure.</b> Aperture photometry in every image gives light curves and spectra; centroids give astrometry.
            </li>
          </ol>
        </Panel>

        <Panel title="How data is labelled">
          <div className="grid gap-3 md:grid-cols-2" style={{ fontSize: 13.5 }}>
            <div className="flex items-start gap-2">
              <ProvChip kind="irsa" force />
              <span className="text-ink2">Real SPHEREx pixels from NASA IRSA. Every image carries this chip.</span>
            </div>
            <div className="flex items-start gap-2">
              <ProvChip kind="derived" force />
              <span className="text-ink2">Computed by COSMIC from real data: differences, stacks, mover candidates, photometry.</span>
            </div>
            <div className="flex items-start gap-2">
              <ProvChip kind="catalogue" force />
              <span className="text-ink2">Names and positions from SIMBAD and Gaia DR3, proper motion applied to the date shown.</span>
            </div>
            <div className="flex items-start gap-2">
              <ProvChip kind="simulated" force />
              <span className="text-ink2">Made-up test data, used only in the Planet X Lab injection test. Never mixed silently with real data.</span>
            </div>
          </div>
          <p className="mb-0 mt-3 text-ink2" style={{ fontSize: 13.5 }}>
            Rings are <b>candidates, not discoveries</b>. A named ring matches a catalogued object; an orange one reads &ldquo;Unidentified candidate &ndash; needs further scientific investigation&rdquo;. There is no Planet X in any archive: the Planet X Lab tests whether we <i>could</i> find one.
          </p>
        </Panel>

        <Panel title="References">
          <ul className="m-0 space-y-1 pl-4">
            <li>
              <a className="link" href="https://irsa.ipac.caltech.edu/Missions/spherex.html" target="_blank" rel="noreferrer">
                IRSA SPHEREx page
              </a>{" "}
              ·{" "}
              <a className="link" href="https://caltech-ipac.github.io/irsa-tutorials/spherex/" target="_blank" rel="noreferrer">
                SPHEREx tutorial notebooks
              </a>
            </li>
            <li>
              SPHEREx mission paper:{" "}
              <a className="link" href="https://arxiv.org/abs/2511.02985" target="_blank" rel="noreferrer">
                arXiv:2511.02985
              </a>
            </li>
            <li>
              Inspiration:{" "}
              <a className="link" href="http://byw.tools/wiseview" target="_blank" rel="noreferrer">
                WiseView
              </a>{" "}
              and Backyard Worlds. Planet Nine hypothesis: Batygin &amp; Brown 2016, AJ 151, 22.
            </li>
            <li>
              Try it:{" "}
              <Link className="link" to="/explorer">
                Blink Explorer
              </Link>
            </li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}
