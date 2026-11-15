import type { ComponentType } from "react";
import { Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import { AppBanners } from "./components/AppBanners";
import { TopBar } from "./components/TopBar";
import { ErrorBoundary } from "./components/ui";
import AnalysisPage from "./pages/AnalysisPage";
import BlinkExplorer from "./pages/BlinkExplorer";
import CandidatesPage from "./pages/CandidatesPage";
import ComparePage from "./pages/ComparePage";
import MissionPage from "./pages/MissionPage";
import MissionControl from "./pages/MissionControl";
import Placeholder from "./pages/Placeholder";
import PlanetXPage from "./pages/PlanetXPage";
import SettingsPage from "./pages/SettingsPage";

/** The assistant (Cosmo) is a separate module owned by the AI-assistant role. It is loaded only
 * when its files are present, so the app builds and runs with or without it. */
const assistantModules = import.meta.glob<{ Assistant: ComponentType }>("./components/assistant/Assistant.tsx", { eager: true });
const Assistant: ComponentType = Object.values(assistantModules)[0]?.Assistant ?? (() => null);

/** Remount the explorer whenever its search params change, so a new ?ra=&dec= link
 * builds that field even when the page is already open. */
function ExplorerRoute() {
  const [params] = useSearchParams();
  return <BlinkExplorer key={params.toString()} params={params} />;
}

export default function App() {
  const [params] = useSearchParams();
  const loc = useLocation();
  const embed = params.get("embed") === "1"; // embedded in another site: no masthead
  return (
    <div className="grid h-full" style={{ gridTemplateRows: embed ? "auto minmax(0,1fr)" : "auto auto minmax(0,1fr)", gridTemplateColumns: "minmax(0,1fr)" }}>
      {!embed && <TopBar />}
      {/* always a grid row, even when no banner shows, so <main> keeps the 1fr row */}
      <div className="min-w-0">
        <AppBanners />
      </div>
      <main className="relative min-h-0 min-w-0 overflow-hidden">
        <ErrorBoundary key={loc.pathname}>
          <Routes>
            <Route path="/" element={<MissionControl />} />
            <Route path="/explorer" element={<ExplorerRoute />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/compare" element={<ComparePage />} />
            <Route path="/analysis" element={<AnalysisPage />} />
            <Route path="/candidates" element={<CandidatesPage />} />
            <Route path="/planetx" element={<PlanetXPage />} />
            <Route path="/mission" element={<MissionPage />} />
            <Route path="*" element={<Placeholder title="Not found" text="This page does not exist." />} />
          </Routes>
        </ErrorBoundary>
      </main>
      <Assistant />
    </div>
  );
}
