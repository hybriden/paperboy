import "@fontsource-variable/hanken-grotesk";
import "@fontsource-variable/newsreader";
import "@fontsource-variable/jetbrains-mono";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { ToastProvider } from "./components/ui/toast.js";
import { TooltipProvider } from "./components/ui/tooltip.js";
import { ThemeProvider } from "./lib/theme.js";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
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
