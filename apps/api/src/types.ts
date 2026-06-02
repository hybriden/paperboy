import type { AccessContext, Database, Perspective } from "@paperboy/db";
import type { SessionUser } from "@paperboy/shared";

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    cookieName: string;
    cookieSecure: boolean;
    corsOrigin: string;
    sessionSecret: string;
    loginRateMax: number;
    uploadsDir: string;
    aiConfig: { apiKey?: string; model: string };
  }
  interface FastifyRequest {
    user: SessionUser | null;
    accessCtx: AccessContext | null;
    sessionToken: string | null;
    sessionCsrf: string | null;
    perspective: Perspective | null;
  }
}

export {};
