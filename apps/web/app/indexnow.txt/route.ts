import { publicFileResponse } from "../lib/public-file";

/** IndexNow key file (Settings → General → Public files → IndexNow); 404 while it's off. */
export const dynamic = "force-dynamic"; // never prerendered: the CMS isn't reachable at build time

export async function GET(): Promise<Response> {
  return publicFileResponse("indexnow.txt");
}
