import { isNoise404, normalizePath } from "@paperboy/shared";
import { describe, expect, it } from "vitest";

/**
 * The 404 log (Settings → Redirects → Not found) exists to surface broken links
 * worth a redirect. Both lists are real paths from a production site's log
 * (skya.no, a week after moving off WordPress): scanners buried its ~30 real
 * entries under ~1 300 probes, each with its own "Create redirect" button.
 */
const noise = [
  // WordPress internals under any folder, not only at the root
  "/wp-json/wp/v2/users/me",
  "/wp-json",
  "/blog/wp-includes/wlwmanifest.xml",
  "/2019/wp-includes/wlwmanifest.xml",
  "/news/wp-json",
  "/index.php/wp-json/wp/v2/users",
  "/wp-content/plugins/elementor/assets/js/frontend.min.js",
  "/wp-content/themes/hello-elementor/assets/css/theme.css",
  "/wp-content/cache/min/1/wp-content/themes/hello-elementor/assets/js/hello-frontend.js",
  "/wp-content/uploads/wc-logs",
  "/wp-content/uploads/2024",
  "/wp-content",
  "/wp-sitemap-users-1.xml",
  // secrets and dotfiles
  "/.aws/credentials",
  "/.ssh/id_rsa",
  "/.npmrc",
  "/.svn/wc.db",
  "/.hg/requires",
  "/.claude/settings.local.json",
  "/~/.aws/credentials",
  "/app/.git/config",
  "/regnskapssystemer/.git/config",
  "/.well-known",
  // config, build and backup files
  "/config.json",
  "/credentials.json",
  "/docker-compose.yml",
  "/terraform.tfstate",
  "/terraform.tfvars",
  "/application.properties",
  "/key.pem",
  "/server.key",
  "/backup.sql.gz",
  "/www.zip",
  "/database.sqlite",
  "/main.js.map",
  "/_next/static/chunks/main.js",
  "/_nuxt/entry.js",
  "/@vite/env",
  "/claude.md",
  "/settings.py",
  "/phpinfo.php~",
  "/web.config",
  // platform consoles and endpoints
  "/actuator/env",
  "/message-api/actuator/env",
  "/phpinfo",
  "/server-status",
  "/web-inf/web.xml",
  "/_vti_bin/*",
  "/telerik.web.ui.webresource.axd",
  "/login.action",
  "/autodiscover/autodiscover.xml",
  "/proc/self/environ",
  "/api/proc/self/environ",
  // port probes, link schemes read as paths, route templates
  "/:3306",
  "/tel:+4794099928",
  "/mailto:post@skya.no",
  "/[slug]",
  "/api/*",
  "/$(pwd)/.env.local",
];

const real = [
  // the old site's media, still linked from e-mail signatures and other sites
  "/wp-content/uploads/2024/10/skya-logo-regnskap-markedsforing-lonn-011.png",
  "/wp-content/uploads/2022/01/skyaccounting-7.jpg",
  // the old site's pages, feeds and short URLs
  "/feriepenger-ferieavvikling-og-sesongarbeid/",
  "/tag/feriepenger/feed",
  "/author/charlotteskya-no",
  "/tripletex",
  "/regnskapssystemer/24sevenoffice",
  "/karriere",
  "/ansatte",
  "/about-us",
  "/blog",
  "/company-information.html",
  "/2024/10/28",
  "/en/kontakt-oss",
  // root files a site may want to serve
  "/.well-known/security.txt",
  "/llms-full.txt",
  "/favicon.png",
];

describe("isNoise404", () => {
  it.each(noise)("drops %s", (path) => {
    expect(isNoise404(normalizePath(path))).toBe(true);
  });

  it.each(real)("keeps %s", (path) => {
    expect(isNoise404(normalizePath(path))).toBe(false);
  });
});
