import { publicFileResponse } from "../lib/public-file";

/** llms.txt (llmstxt.org), generated from published pages + site config. */
export const dynamic = "force-dynamic"; // never prerendered: the CMS isn't reachable at build time

export async function GET(): Promise<Response> {
  return publicFileResponse("llms.txt");
}
