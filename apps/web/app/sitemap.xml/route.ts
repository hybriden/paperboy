import { publicFileResponse } from "../lib/public-file";

/** Content-driven sitemap from the CMS — never stale on publish. */
export const dynamic = "force-dynamic"; // never prerendered: the CMS isn't reachable at build time

export async function GET(): Promise<Response> {
  return publicFileResponse("sitemap.xml");
}
