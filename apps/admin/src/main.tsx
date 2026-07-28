import "@fontsource-variable/hanken-grotesk";
import "@fontsource-variable/newsreader";
import "@fontsource-variable/jetbrains-mono";

import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { QueryErrorToaster } from "./components/QueryErrorToaster.js";
import { ToastProvider } from "./components/ui/toast.js";
import { TooltipProvider } from "./components/ui/tooltip.js";
import { ThemeProvider } from "./lib/theme.js";
import "./index.css";

/**
 * A failed query used to be terminal AND silent: `retry: false` with no
 * `onError` anywhere, and ErrorBoundary only catches render throws. So one dropped
 * request left panels blank — or worse, stating something false, because
 * `data?.x ?? false` reads a fetch failure as "off" (2FA, the agent-review gate,
 * "no AI key", dashboard zeros).
 *
 * One retry absorbs the common transient blip; the cache-level onError makes
 * anything that still fails VISIBLE. The toast lives in the React tree, so the
 * error is announced through a DOM event (same pattern as `pb:dragsource`).
 */
export const QUERY_ERROR_EVENT = "pb:queryerror";

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
