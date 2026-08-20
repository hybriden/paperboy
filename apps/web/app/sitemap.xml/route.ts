import { publicFileResponse } from "../lib/public-file";

/** Content-driven sitemap from the CMS — never stale on publish. */
export async function GET(): Promise<Response> {
  return publicFileResponse("sitemap.xml");
}
