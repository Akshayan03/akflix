import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import AppErrorBoundary from "./components/AppErrorBoundary";
import { trimCatalogCache } from "./lib/safeStorage";
import "./index.css";

// Older builds let the catalog cache fill WebKit's storage quota, which made
// every later write fail. Restore headroom before any store persists.
trimCatalogCache();

// HashRouter: works identically under Vite dev and Tauri's file protocol.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <HashRouter>
        <App />
      </HashRouter>
    </AppErrorBoundary>
  </React.StrictMode>
);
