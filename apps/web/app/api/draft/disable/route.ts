import { draftMode } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest): Promise<NextResponse> {
  (await draftMode()).disable();
  return NextResponse.redirect(new URL("/en/home", req.url));
}
