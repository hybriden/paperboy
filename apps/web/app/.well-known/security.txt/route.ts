import { publicFileResponse } from "../../lib/public-file";

/** RFC 9116 security.txt — 404 until a security contact is set in the CMS. */
export const dynamic = "force-dynamic"; // never prerendered: the CMS isn't reachable at build time

export async function GET(): Promise<Response> {
  return publicFileResponse("security.txt");
}
