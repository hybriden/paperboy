import { draftMode } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { DEFAULT_LOCALE } from "../../../lib/locale";

export async function GET(req: NextRequest): Promise<NextResponse> {
  (await draftMode()).disable();
  return NextResponse.redirect(new URL(`/${DEFAULT_LOCALE}/home`, req.url));
}
