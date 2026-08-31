import "@fontsource-variable/hanken-grotesk";
import "@fontsource-variable/newsreader";
import "@fontsource-variable/jetbrains-mono";

import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { QUERY_ERROR_EVENT, QueryErrorToaster } from "./components/QueryErrorToaster.js";
import { ToastProvider } from "./components/ui/toast.js";
import { TooltipProvider } from "./components/ui/tooltip.js";
import { ThemeProvider } from "./lib/theme.js";
import "./index.css";

// One retry absorbs a transient blip; whatever still fails is announced as a DOM
// event, because the toast that shows it (QueryErrorToaster) lives inside the React tree.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
  queryCache: new QueryCache({
    onError: (error) => {
      window.dispatchEvent(
        new CustomEvent(QUERY_ERROR_EVENT, {
          detail: error instanceof Error ? error.message : "Request failed",
        }),
      );
    },
  }),
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          {/* Inside ToastProvider: turns query failures into a visible toast. */}
          <QueryErrorToaster />
          <TooltipProvider>
            <ErrorBoundary>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </ErrorBoundary>
          </TooltipProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
