import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

// Hosting platforms (App Service, Container Apps, Cloud Run, Render, Railway,
// Fly, Heroku) tell the process which port to bind through PORT. API_PORT stays
// the explicit setting and wins when both are present.
const base = { DATABASE_URL: "postgresql://paperboy:paperboy@localhost:5433/paperboy", NODE_ENV: "test" as const };

describe("listen port", () => {
  it("defaults to 8091", () => {
    expect(loadEnv({ ...base, API_PORT: undefined, PORT: undefined }).API_PORT).toBe(8091);
  });

  it("uses the platform's PORT when API_PORT is unset", () => {
    expect(loadEnv({ ...base, API_PORT: undefined, PORT: "3000" }).API_PORT).toBe(3000);
  });

  it("treats an empty API_PORT as unset (compose passes empty variables through)", () => {
    expect(loadEnv({ ...base, API_PORT: "", PORT: "3000" }).API_PORT).toBe(3000);
  });

  it("prefers API_PORT over PORT", () => {
    expect(loadEnv({ ...base, API_PORT: "8091", PORT: "3000" }).API_PORT).toBe(8091);
  });
});
