import { NextResponse } from "next/server";
import {
  getAccessToken,
  fetchAllPlaylists,
  fetchAllPlaylistTracks,
  fetchArtistsByIds,
} from "@/app/lib/spotify";

type ArtistAgg = {
  artistId: string;
  artistName: string;
  songCount: number;
  playlistCount: number;
  imageUrl: string | null;
};

type TrackPlaylistAgg = {
  trackId: string;
  trackName: string;
  mainArtistId: string | null;
  mainArtistName: string;
  mainArtistImageUrl: string | null;
  playlistCount: number;
};

export async function GET() {
  const token = await getAccessToken();
  if (!token) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  const playlists = await fetchAllPlaylists(token);
  const totalPlaylists = playlists.length;

  const uniqueTrackIds = new Set<string>();

  // artistId -> { name, songCount, playlistCount, imageUrl }
  const artistMap = new Map<
    string,
    { name: string; songCount: number; playlistCount: number; imageUrl: string | null }
  >();

  // trackId -> { name, mainArtistId, mainArtistName, playlistCount, mainArtistImageUrl }
  const trackPlaylistMap = new Map<
    string,
    {
      name: string;
      mainArtistId: string | null;
      mainArtistName: string;
      mainArtistImageUrl: string | null;
      playlistCount: number;
    }
  >();

  for (const pl of playlists) {
    const playlistId = pl?.id;
    if (!playlistId) continue;

    const items = await fetchAllPlaylistTracks(token, playlistId);

    const artistIdsInPlaylist = new Set<string>();
    const trackIdsInPlaylist = new Set<string>();

    for (const it of items) {
      const track = it?.track;
      if (!track || track.type !== "track") continue;

      const trackId: string | null = track.id ?? null;
      if (!trackId) continue; // ignore local files/null ids

      trackIdsInPlaylist.add(trackId);

      if (!trackPlaylistMap.has(trackId)) {
        const trackName = track.name ?? "Unknown track";
        const mainArtist = track.artists?.[0] ?? null;
        const mainArtistId = mainArtist?.id ?? null;
        const mainArtistName = mainArtist?.name ?? "Unknown artist";

        trackPlaylistMap.set(trackId, {
          name: trackName,
          mainArtistId,
          mainArtistName,
          mainArtistImageUrl: null,
          playlistCount: 0,
        });
      }

      const isNewUniqueTrack = !uniqueTrackIds.has(trackId);
      if (isNewUniqueTrack) {
        uniqueTrackIds.add(trackId);

        for (const a of track.artists ?? []) {
          const artistId = a?.id;
          const artistName = a?.name;
          if (!artistId || !artistName) continue;

          const prev = artistMap.get(artistId);
          if (prev) prev.songCount += 1;
          else artistMap.set(artistId, { name: artistName, songCount: 1, playlistCount: 0, imageUrl: null });
        }
      }

      // playlist presence (count once per playlist)
      for (const a of track.artists ?? []) {
        const artistId = a?.id;
        const artistName = a?.name;
        if (!artistId || !artistName) continue;

        artistIdsInPlaylist.add(artistId);
        if (!artistMap.has(artistId)) {
          artistMap.set(artistId, { name: artistName, songCount: 0, playlistCount: 0, imageUrl: null });
        }
      }
    }

    for (const artistId of artistIdsInPlaylist) {
      const rec = artistMap.get(artistId);
      if (rec) rec.playlistCount += 1;
    }

    for (const trackId of trackIdsInPlaylist) {
      const rec = trackPlaylistMap.get(trackId);
      if (rec) rec.playlistCount += 1;
    }
  }

  const totalUniqueTracks = uniqueTrackIds.size;

  // ---------- Fetch artist images (batch) ----------
  const allArtistIds = Array.from(artistMap.keys());
  if (allArtistIds.length > 0) {
    const artistObjs = await fetchArtistsByIds(token, allArtistIds);

    const imageByArtistId = new Map<string, string | null>();
    for (const a of artistObjs) {
      const id = a?.id;
      if (!id) continue;
      const url = Array.isArray(a?.images) && a.images.length > 0 ? (a.images[0]?.url ?? null) : null;
      imageByArtistId.set(id, url);
    }

    // Fill artist images
    for (const [artistId, rec] of artistMap.entries()) {
      rec.imageUrl = imageByArtistId.get(artistId) ?? null;
    }

    // Fill main-artist image for top tracks too (if mainArtistId exists)
    for (const [, rec] of trackPlaylistMap.entries()) {
      if (rec.mainArtistId) {
        rec.mainArtistImageUrl = imageByArtistId.get(rec.mainArtistId) ?? null;
      }
    }
  }

  const artists: ArtistAgg[] = Array.from(artistMap.entries()).map(([artistId, v]) => ({
    artistId,
    artistName: v.name,
    songCount: v.songCount,
    playlistCount: v.playlistCount,
    imageUrl: v.imageUrl ?? null,
  }));

  // Sort for deck (by songs desc then name)
  artists.sort((a, b) => b.songCount - a.songCount || a.artistName.localeCompare(b.artistName));

  const pct = (x: number, denom: number) => (denom > 0 ? (x / denom) * 100 : 0);

  const topArtistsBySongs = [...artists]
    .sort((a, b) => b.songCount - a.songCount || a.artistName.localeCompare(b.artistName))
    .slice(0, 5)
    .map((a) => ({
      artistId: a.artistId,
      artistName: a.artistName,
      imageUrl: a.imageUrl,
      value: a.songCount,
      percent: pct(a.songCount, totalUniqueTracks),
    }));

  const topArtistsByPlaylists = [...artists]
    .sort((a, b) => b.playlistCount - a.playlistCount || a.artistName.localeCompare(b.artistName))
    .slice(0, 5)
    .map((a) => ({
      artistId: a.artistId,
      artistName: a.artistName,
      imageUrl: a.imageUrl,
      value: a.playlistCount,
      percent: pct(a.playlistCount, totalPlaylists),
    }));

  const topTracksByPlaylists: TrackPlaylistAgg[] = Array.from(trackPlaylistMap.entries())
    .map(([trackId, v]) => ({
      trackId,
      trackName: v.name,
      mainArtistId: v.mainArtistId,
      mainArtistName: v.mainArtistName,
      mainArtistImageUrl: v.mainArtistImageUrl ?? null,
      playlistCount: v.playlistCount,
    }))
    .sort((a, b) => b.playlistCount - a.playlistCount || a.trackName.localeCompare(b.trackName))
    .slice(0, 5);

  const artistTable = artists.map((a) => ({
    artistId: a.artistId,
    artistName: a.artistName,
    imageUrl: a.imageUrl,
    songCount: a.songCount,
    songPercent: pct(a.songCount, totalUniqueTracks),
    playlistCount: a.playlistCount,
    playlistPercent: pct(a.playlistCount, totalPlaylists),
  }));

  return NextResponse.json({
    totals: {
      totalPlaylists,
      totalArtists: artists.length,
      totalUniqueTracks,
    },
    topArtistsBySongs,
    topArtistsByPlaylists,
    topTracksByPlaylists: topTracksByPlaylists.map((t) => ({
      ...t,
      percent: pct(t.playlistCount, totalPlaylists),
    })),
    artistTable,
    artists: artists.map((a) => ({
      artistId: a.artistId,
      artistName: a.artistName,
      imageUrl: a.imageUrl,
      trackCount: a.songCount,
    })),
  });
}
