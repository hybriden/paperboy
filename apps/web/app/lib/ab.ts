import { applyExperiments, type DeliveryContent, type ExperimentExposure } from "@paperboycms/client";

/**
 * A/B experiments: the visitor key and the per-page pick.
 *
 * The version is picked on the SERVER from a visitor key, never swapped in the
 * browser (that flickers). Two privacy modes, from env PAPERBOY_AB_MODE:
 *
 *  - `cookieless` (default): a fresh random key per page view. Nothing is stored
 *    on the device, so no consent is needed; only a goal on the same page (a
 *    form) can be attributed.
 *  - `consent`: a first-party random `pb_vid` cookie (13 months) so a visitor
 *    keeps their version, set ONLY while the consent cookie
 *    (PAPERBOY_AB_CONSENT_COOKIE, default `pb_consent`, "1"/"true") is present.
 *    In Norway a cookie that remembers the version needs consent (ekomloven
 *    §3-15): it is not "strictly necessary". Without consent: cookieless.
 *
 * The user agent is never read: robots get a key like anyone (or none), and
 * showing crawlers something else would be cloaking.
 */

export const VISITOR_COOKIE = "pb_vid";
export const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 395; // 13 months

type Env = Record<string, string | undefined>;
type CookieReader = { get(name: string): { value: string } | undefined };

/** Consent mode AND the visitor consented: only then may `pb_vid` exist. */
export function mayRememberVisitor(cookies: CookieReader, env: Env = process.env): boolean {
  if (env.PAPERBOY_AB_MODE !== "consent") return false;
  const consent = cookies.get(env.PAPERBOY_AB_CONSENT_COOKIE || "pb_consent")?.value;
  return consent === "1" || consent === "true";
}

/** The key this page view is assigned with: the remembered id when allowed, else a fresh one. */
export function visitorKey(cookies: CookieReader, env: Env = process.env): string {
  const remembered = mayRememberVisitor(cookies, env) ? cookies.get(VISITOR_COOKIE)?.value : undefined;
  return remembered || crypto.randomUUID();
}

/**
 * What the proxy does with `pb_vid` on this request: mint it (consented, none
 * yet), delete it (consent withdrawn or cookieless mode), or leave it.
 */
export function visitorCookieAction(cookies: CookieReader, env: Env = process.env): "set" | "delete" | null {
  const has = cookies.get(VISITOR_COOKIE) !== undefined;
  if (mayRememberVisitor(cookies, env)) return has ? null : "set";
  return has ? "delete" : null;
}

/**
 * The page's rendered item and the exposures to report. Preview shows the
 * version the admin forced (`?pbab=<id>:<arm>`, honoured only because the
 * caller passed the preview check) or A, and is never counted.
 */
export function experimentView<T extends DeliveryContent>(
  content: T,
  opts: { preview: boolean; pbab?: string | string[]; visitorKey: () => string },
): { item: T; exposures: ExperimentExposure[] } {
  if (!content.experiments?.length) return { item: content, exposures: [] };
  if (opts.preview) {
    const force = typeof opts.pbab === "string" ? opts.pbab : null;
    return { item: applyExperiments(content, { force }).item, exposures: [] };
  }
  return applyExperiments(content, { visitorKey: opts.visitorKey() });
}
