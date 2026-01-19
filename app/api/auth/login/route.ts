export const runtime = "nodejs";

import { NextResponse } from "next/server";

function randomString(len = 32) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function GET(req: Request) {
  const host = req.headers.get("host")!;
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const origin = `${proto}://${host}`;
  const redirectUri = `${origin}/api/auth/callback`;


  const state = randomString(16);

  const scope = ["playlist-read-private", "playlist-read-collaborative"].join(" ");

  const authUrl = new URL("https://accounts.spotify.com/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", process.env.SPOTIFY_CLIENT_ID!);
  authUrl.searchParams.set("scope", scope);

  // --- Use dynamic redirect instead of env variable ---
  authUrl.searchParams.set("redirect_uri", redirectUri);

  authUrl.searchParams.set("state", state);

  const res = NextResponse.redirect(authUrl.toString());

  res.cookies.set("spotify_auth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,   // correct for http dev
    path: "/",
    maxAge: 10 * 60,
  });

  return res;
}
