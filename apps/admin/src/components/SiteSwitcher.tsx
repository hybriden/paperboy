import { useQuery } from "@tanstack/react-query";
import { ACTIVE_SITE_KEY, api, getActiveSite, setActiveSite } from "../lib/api.js";
import { can, useUser } from "../lib/user.js";

const NEW_SITE = "__new__";

/**
 * Multisite site switcher (header). Lists the sites and switches the active one
 * by persisting it + reloading, so every query refetches under the new site's
 * x-paperboy-site header. Hidden when there's only one site and the user can't
 * create more. Admins (user.manage) get a "New site…" action.
 */
export function SiteSwitcher() {
  const { user } = useUser();
  const canManage = can(user, "user.manage");
  const { data } = useQuery({ queryKey: ["sites"], queryFn: () => api.sites(), staleTime: 60_000 });

  if (!data) return null;
  const sites = data.sites;
  if (sites.length <= 1 && !canManage) return null; // nothing to switch, can't create

  const active = getActiveSite() ?? data.activeSiteId;

  function switchTo(id: string) {
    setActiveSite(id);
    localStorage.setItem(ACTIVE_SITE_KEY, id);
    // Full reload from the content root: the active site changes the entire
    // content surface, so refetch everything cleanly rather than reconciling.
    window.location.href = "/edit";
  }

  return (
    <label className="flex items-center gap-1.5" title="Active site">
      <span className="sr-only">Active site</span>
      <select
        value={active}
        onChange={(e) => {
          // Creation lives in Settings → Site (name + slug + default locale).
          if (e.target.value === NEW_SITE) window.location.href = "/settings#site";
          else if (e.target.value !== active) switchTo(e.target.value);
        }}
        className="max-w-[160px] truncate rounded-[var(--radius)] border border-line bg-canvas px-2 py-1.5 text-sm text-fg hover:bg-line/60 focus:outline-none"
        aria-label="Active site"
      >
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        {canManage && <option value={NEW_SITE}>＋ New site…</option>}
      </select>
    </label>
  );
}
