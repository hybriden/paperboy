import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { SessionUser } from "@paperboy/shared";
import { Login } from "./components/Login.js";
import { Shell } from "./components/Shell.js";
import { DashboardView, SettingsView } from "./components/views/Views.js";
import { EditView } from "./components/views/EditView.js";
import { ACTIVE_SITE_KEY, api, setActiveSite, setCsrf, setUnauthorizedHandler } from "./lib/api.js";
import { UserContext } from "./lib/user.js";

export function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  useEffect(() => {
    // Restore the active site (multisite) before any content query runs.
    setActiveSite(localStorage.getItem(ACTIVE_SITE_KEY));
    setUnauthorizedHandler(() => {
      setCsrf(null);
      setUser(null);
      qc.clear(); // drop one principal's RBAC/site-scoped cache at the auth boundary (S3-M4)
    });
    api
      .me()
      .then(({ user, csrfToken }) => {
        setCsrf(csrfToken);
        setUser(user);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
    return () => setUnauthorizedHandler(null);
  }, [qc]);

  async function logout() {
    try {
      await api.logout();
    } finally {
      setCsrf(null);
      setUser(null);
      qc.clear(); // no previous-session data survives into the next login (S3-M4)
    }
  }

  // Clear any stale cache before a fresh principal's data loads (e.g. the SPA was
  // opened with a different live session cookie than the last in-memory user).
  function onLogin(u: SessionUser) {
    qc.clear();
    setUser(u);
  }

  if (loading) {
    return (
      <div className="grid h-full place-items-center bg-canvas">
        <div className="masthead animate-fade-in text-3xl text-fg">Paperboy</div>
      </div>
    );
  }
  if (!user) return <Login onLogin={onLogin} />;

  return (
    <UserContext.Provider value={{ user, logout }}>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Navigate to="/edit" replace />} />
          <Route path="edit" element={<EditView />} />
          <Route path="edit/:documentId" element={<EditView />} />
          <Route path="dashboard" element={<DashboardView />} />
          <Route path="settings" element={<SettingsView />} />
          <Route path="*" element={<Navigate to="/edit" replace />} />
        </Route>
      </Routes>
    </UserContext.Provider>
  );
}
