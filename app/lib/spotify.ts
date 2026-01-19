import { cookies } from "next/headers";

type Paging<T> = {
  items: T[];
  next: string | null;
};

async function spotifyFetch(url: string, token: string) {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Spotify API error ${r.status}: ${txt}`);
  }
  return r.json();
}

export async function getAccessToken(): Promise<string | null> {
  const c = await cookies();
  return c.get("sp_access_token")?.value ?? null;
}

export async function fetchAllPlaylists(token: string) {
  const out: any[] = [];
  let url = "https://api.spotify.com/v1/me/playlists?limit=50";

  while (url) {
    const page = (await spotifyFetch(url, token)) as Paging<any>;
    out.push(...page.items);
    url = page.next;
  }
  return out;
}

export async function fetchAllPlaylistTracks(token: string, playlistId: string) {
  const out: any[] = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;

  while (url) {
    const page = (await spotifyFetch(url, token)) as Paging<any>;
    out.push(...page.items);
    url = page.next;
  }
  return out;
}

export async function fetchArtistsByIds(token: string, ids: string[]) {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const url = `https://api.spotify.com/v1/artists?ids=${encodeURIComponent(chunk.join(","))}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Spotify artists batch error ${r.status}: ${txt}`);
    }
    const j = await r.json();
    out.push(...(j.artists ?? []));
  }
  return out;
}

