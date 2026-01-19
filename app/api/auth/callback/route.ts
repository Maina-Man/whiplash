export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";

async function exchangeCodeForTokens(code: string, redirectUri: string) {
  const clientId = process.env.SPOTIFY_CLIENT_ID!;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET!;

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", redirectUri);

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Token exchange failed: ${r.status} ${txt}`);
  }

  return r.json() as Promise<{
    access_token: string;
    token_type: string;
    scope: string;
    expires_in: number;
    refresh_token?: string;
  }>;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const storedState = req.cookies.get("spotify_auth_state")?.value;

  const host = req.headers.get("host")!;
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const origin = `${proto}://${host}`;
  const redirectUri = `${origin}/api/auth/callback`;


  if (!code || !state || !storedState || state !== storedState) {
    return NextResponse.redirect(`${origin}/?error=auth_state`);
  }

  try {
    const tokens = await exchangeCodeForTokens(code, redirectUri);

    const res = NextResponse.redirect(`${origin}/`);

    res.cookies.set("sp_access_token", tokens.access_token, {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // true in production https
      path: "/",
      maxAge: Math.max(60, tokens.expires_in - 30),
    });

    if (tokens.refresh_token) {
      res.cookies.set("sp_refresh_token", tokens.refresh_token, {
        httpOnly: true,
        sameSite: "lax",
        secure: false,
        path: "/",
        maxAge: 30 * 24 * 60 * 60,
      });
    }

    res.cookies.delete("spotify_auth_state");
    return res;
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });

  }
}
