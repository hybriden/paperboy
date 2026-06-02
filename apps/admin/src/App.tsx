import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { SessionUser } from "@paperboy/shared";
import { Login } from "./components/Login.js";
import { Shell } from "./components/Shell.js";
import { DashboardView, SettingsView } from "./components/views/Views.js";
import { EditView } from "./components/views/EditView.js";
import { api, setCsrf, setUnauthorizedHandler } from "./lib/api.js";
import { UserContext } from "./lib/user.js";

export function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCsrf(null);
      setUser(null);
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
  }, []);

  async function logout() {
    try {
      await api.logout();
    } finally {
      setCsrf(null);
      setUser(null);
    }
  }

  if (loading) {
    return (
      <div className="grid h-full place-items-center bg-chrome">
        <div className="masthead animate-fade-in text-3xl text-chrome-fg">Paperboy</div>
      </div>
    );
  }
  if (!user) return <Login onLogin={setUser} />;

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
