import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { HealthProvider } from "./hooks/useHealth";
import "./index.css";
import { CandidatesProvider } from "./state/candidates";
import { SettingsProvider } from "./state/settings";
import { ViewProvider } from "./state/view";
import { WorkspaceProvider } from "./state/workspace";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <SettingsProvider>
        <HealthProvider>
        <WorkspaceProvider>
          <ViewProvider>
            <CandidatesProvider>
              <App />
            </CandidatesProvider>
          </ViewProvider>
        </WorkspaceProvider>
        </HealthProvider>
      </SettingsProvider>
    </BrowserRouter>
  </StrictMode>,
);
