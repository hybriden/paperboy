import { createHash, randomBytes } from "node:crypto";
import { type Page, expect, test } from "@playwright/test";

/**
 * The MCP OAuth consent screen (/oauth/authorize). An MCP client sends the
 * user here; they sign in with the admin's own login, see who is asking, pick
 * the site the connection may reach — one site, or every site when they can see
 * them all — and are sent back to the client with an authorization code.
 */

const REDIRECT = "https://client.example.net/callback";

async function registerClient(page: Page): Promise<string> {
  const res = await page.request.post("/api/v1/oauth/register", { data: { client_name: "Consent Test Client", redirect_uris: [REDIRECT] } });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizeUrl(clientId: string): { url: string; verifier: string } {
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "e2e-state",
  });
  return { url: `/oauth/authorize?${q}`, verifier };
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("an Editor signs in, picks 'every site' and is sent back with a code", async ({ page }) => {
  const clientId = await registerClient(page);
  const { url, verifier } = authorizeUrl(clientId);
  let landed = "";
  await page.route("https://client.example.net/**", (route) => {
    landed = route.request().url();
    return route.fulfill({ status: 200, body: "client callback" });
  });

  await page.goto(url);
  await signIn(page, "editor@paperboy.test", "Editor!Passw0rd"); // the admin's own login
  await expect(page.getByText("Consent Test Client")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("client.example.net")).toBeVisible();
  await page.getByRole("radio", { name: /Every site/ }).check();
  await page.getByRole("button", { name: "Allow" }).click();

  await expect.poll(() => landed, { timeout: 10_000 }).toContain("code=");
  const back = new URL(landed);
  expect(back.searchParams.get("state")).toBe("e2e-state");

  // The code is real: it exchanges for a token.
  const tok = await page.request.post("/api/v1/oauth/token", {
    form: { grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT },
  });
  expect(tok.status(), await tok.text()).toBe(200);
});

test("an Author is only offered the sites they work in — never 'every site'", async ({ page }) => {
  const clientId = await registerClient(page);
  await page.goto(authorizeUrl(clientId).url);
  await signIn(page, "author@paperboy.test", "Author!Passw0rd");
  await expect(page.getByText("Consent Test Client")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("radio")).not.toHaveCount(0);
  await expect(page.getByRole("radio", { name: /Every site/ })).toHaveCount(0);
});

test("cancelling sends the user back with access_denied", async ({ page }) => {
  const clientId = await registerClient(page);
  let landed = "";
  await page.route("https://client.example.net/**", (route) => {
    landed = route.request().url();
    return route.fulfill({ status: 200, body: "client callback" });
  });
  await page.goto(authorizeUrl(clientId).url);
  await signIn(page, "editor@paperboy.test", "Editor!Passw0rd");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => landed, { timeout: 10_000 }).toContain("error=access_denied");
});

test("an unregistered redirect is refused on the page, never followed", async ({ page }) => {
  const clientId = await registerClient(page);
  const url = authorizeUrl(clientId).url.replace(encodeURIComponent(REDIRECT), encodeURIComponent("https://attacker.example/cb"));
  await page.goto(url);
  await signIn(page, "editor@paperboy.test", "Editor!Passw0rd");
  await expect(page.getByRole("alert")).toContainText(/redirect_uri/i, { timeout: 15_000 });
  expect(new URL(page.url()).host).not.toContain("attacker.example"); // still on the admin, not sent anywhere
});

test("the connection is listed under Settings → Connected apps and can be disconnected", async ({ page }) => {
  const clientId = await registerClient(page);
  const { url, verifier } = authorizeUrl(clientId);
  let landed = "";
  await page.route("https://client.example.net/**", (route) => {
    landed = route.request().url();
    return route.fulfill({ status: 200, body: "client callback" });
  });
  await page.goto(url);
  await signIn(page, "author@paperboy.test", "Author!Passw0rd");
  await page.getByRole("button", { name: "Allow" }).click();
  await expect.poll(() => landed, { timeout: 10_000 }).toContain("code=");
  // What the client does next: exchange the code — that creates the connection.
  const tok = await page.request.post("/api/v1/oauth/token", {
    form: { grant_type: "authorization_code", code: new URL(landed).searchParams.get("code")!, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT },
  });
  expect(tok.status()).toBe(200);

  await page.goto("/settings#connections");
  const row = page.locator("div", { hasText: "Consent Test Client" }).filter({ has: page.getByRole("button", { name: "Disconnect" }) }).last();
  await expect(row).toBeVisible({ timeout: 15_000 });
  page.once("dialog", (d) => void d.accept());
  await row.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("No connected apps.")).toBeVisible();
});
