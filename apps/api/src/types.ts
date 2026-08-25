import type { AccessContext, AiEnv, Database, Perspective } from "@paperboy/db";
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
    previewSecret?: string;
    aiEnv: AiEnv;
    stockConfig: { unsplashKey?: string };
    /** Public form submissions: the anti-spam secret, the per-form rate ceiling,
     *  and the retention fallback for forms that declare none. */
    formConfig: { turnstileSecret?: string; submitRateMax: number; retentionDays: number };
  }
  interface FastifyRequest {
    user: SessionUser | null;
    accessCtx: AccessContext | null;
    sessionToken: string | null;
    sessionCsrf: string | null;
    perspective: Perspective | null;
    /** The site a delivery request is scoped to (from its per-site key). */
    deliverySiteId: string | null;
  }
}
