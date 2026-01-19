import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export async function GET() {
  const c = await cookies();
  const access = c.get("sp_access_token")?.value;
  const refresh = c.get("sp_refresh_token")?.value;

  return NextResponse.json({
    hasAccessToken: Boolean(access),
    hasRefreshToken: Boolean(refresh),
  });
}
