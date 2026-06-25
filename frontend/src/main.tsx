import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// Self-hosted variable fonts (bundled by Vite, no external request) — see index.css /
// tailwind.config.js for the "Inter Variable" / "JetBrains Mono Variable" family names.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import { markFontsReady } from "./state/settings";
import "./index.css";

// Redraw canvas charts once the webfonts are ready (they bake in the fallback otherwise).
if (typeof document !== "undefined" && document.fonts?.ready) {
  void document.fonts.ready.then(markFontsReady);
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
