import { publicFileResponse } from "../lib/public-file";

/** llms.txt (llmstxt.org), generated from published pages + site config. */
export async function GET(): Promise<Response> {
  return publicFileResponse("llms.txt");
}
