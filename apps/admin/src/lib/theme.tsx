import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type ThemeChoice = "light" | "dark" | "system";
type Resolved = "light" | "dark";

interface ThemeCtx {
  choice: ThemeChoice;
  resolved: Resolved;
  setChoice: (c: ThemeChoice) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);
const KEY = "paperboy-theme";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function apply(resolved: Resolved) {
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.style.colorScheme = resolved;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(
    () => (localStorage.getItem(KEY) as ThemeChoice) || "system",
  );
  // The OS preference is the only genuinely external input, so THAT is the
  // state and the resolved theme is derived from it. The old shape recomputed
  // the same value inside an effect and setResolved() it — a render whose only
  // job was to start another render.
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const resolved: Resolved = choice === "system" ? (systemDark ? "dark" : "light") : choice;

  // Painting the attribute IS a side effect, so it stays one.
  useEffect(() => {
    apply(resolved);
  }, [resolved]);

  // One listener for the app's lifetime, updating state from the EVENT. It runs
  // even on an explicit light/dark choice, which costs nothing and means the
  // value is already current if the user switches back to "system".
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const setChoice = useCallback((c: ThemeChoice) => {
    localStorage.setItem(KEY, c);
    setChoiceState(c);
  }, []);

  return <Ctx.Provider value={{ choice, resolved, setChoice }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useTheme must be used within ThemeProvider");
  return c;
}
