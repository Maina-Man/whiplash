"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSwipeable } from "react-swipeable";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

type ArtistDeckItem = {
  artistId: string;
  artistName: string;
  imageUrl?: string | null;
  trackCount: number; // (songs)
};

type Totals = {
  totalPlaylists: number;
  totalArtists: number;
  totalUniqueTracks: number;
};

type TopArtist = {
  artistId: string;
  artistName: string;
  imageUrl?: string | null;
  value: number;
  percent: number;
};

type TopTrack = {
  trackId: string;
  trackName: string;
  mainArtistId?: string | null;
  mainArtistName: string;
  mainArtistImageUrl?: string | null;
  playlistCount: number;
  percent: number;
};

type ArtistRow = {
  artistId: string;
  artistName: string;
  imageUrl?: string | null;
  songCount: number;
  songPercent: number;
  playlistCount: number;
  playlistPercent: number;
};

type ApiResponse = {
  totals: Totals;
  topArtistsBySongs: TopArtist[];
  topArtistsByPlaylists: TopArtist[];
  topTracksByPlaylists: TopTrack[];
  artistTable: ArtistRow[];
  artists: ArtistDeckItem[];
};

type Decisions = Record<string, boolean>; // artistId -> seen?

type ProgressFileV1 = {
  version: 1;
  exportedAt: string;
  data: ApiResponse;
  deckIndex: number;
  decisions: Decisions;
  insightPage?: number;
  mode?: "insights" | "deck";
};

const STORAGE_DECISIONS_KEY = "whiplash_decisions_v1";
const STORAGE_DECK_INDEX_KEY = "whiplash_deck_index_v1";
const STORAGE_SNAPSHOT_KEY = "whiplash_snapshot_v1"; // stores ApiResponse

function pct1(x: number) {
  return Math.round(x * 10) / 10;
}

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON<T>(key: string, value: T) {
  localStorage.setItem(key, JSON.stringify(value));
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadJson(filename: string, obj: unknown) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  downloadBlob(filename, blob);
}

function safeNumber(n: any, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function isProgressFileV1(x: any): x is ProgressFileV1 {
  return (
    x &&
    x.version === 1 &&
    typeof x.exportedAt === "string" &&
    x.data &&
    x.data.totals &&
    Array.isArray(x.data.artists) &&
    typeof x.deckIndex !== "undefined" &&
    x.decisions &&
    typeof x.decisions === "object"
  );
}

export default function Home() {

  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);

  // data
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loadingScan, setLoadingScan] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // view
  const [mode, setMode] = useState<"start" | "insights" | "deck">("start");
  const [insightPage, setInsightPage] = useState(0); // 0..4

  // deck state
  const [decisions, setDecisions] = useState<Decisions>({});
  const [deckIndex, setDeckIndex] = useState(0);

  // resume upload input
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Load local progress once (optional convenience)
  useEffect(() => {
    setDecisions(loadJSON<Decisions>(STORAGE_DECISIONS_KEY, {}));
    setDeckIndex(loadJSON<number>(STORAGE_DECK_INDEX_KEY, 0));

    const snap = loadJSON<ApiResponse | null>(STORAGE_SNAPSHOT_KEY, null);
    if (snap?.totals && snap?.artists) {
      setData(snap);
      // If you have local snapshot, land on insights start screen instead of auto-scan
      setMode("insights");
    }
  }, []);

  async function scanSpotify() {
    setLoadingScan(true);
    setError(null);
    try {
      const r = await fetch("/api/spotify/artists", { cache: "no-store" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as ApiResponse;
      setData(j);
      saveJSON(STORAGE_SNAPSHOT_KEY, j);

      // Clamp deckIndex
      setDeckIndex((prev) => {
        const clamped = Math.min(prev, j.artists.length);
        saveJSON(STORAGE_DECK_INDEX_KEY, clamped);
        return clamped;
      });

      setMode("insights");
      setInsightPage(0);
    } catch (e: any) {
      setError(e?.message || "Scan failed");
      setMode("start");
    } finally {
      setLoadingScan(false);
    }
  }

  // ---------------------------
  // Derived data
  // ---------------------------
  const totals = data?.totals;
  const topSongs = data?.topArtistsBySongs ?? [];
  const topPlaylists = data?.topArtistsByPlaylists ?? [];
  const topTracks = data?.topTracksByPlaylists ?? [];
  const table = data?.artistTable ?? [];
  const insightTotalPages = 5;

  // Alphabetical deck order A->Z
  const deckArtistsSorted = useMemo(() => {
    const arr = [...(data?.artists ?? [])];
    arr.sort((a, b) =>
      a.artistName.localeCompare(b.artistName, undefined, { sensitivity: "base" })
    );
    return arr;
  }, [data]);

  // Keep deckIndex sane when data changes
  useEffect(() => {
    setDeckIndex((prev) => {
      const max = deckArtistsSorted.length;
      const clamped = Math.min(prev, max);
      saveJSON(STORAGE_DECK_INDEX_KEY, clamped);
      return clamped;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckArtistsSorted.length]);

  // ---------------------------
  // Export / Import progress JSON
  // ---------------------------
  function exportProgress() {
    if (!data) return;
    const file: ProgressFileV1 = {
      version: 1,
      exportedAt: new Date().toISOString(),
      data,
      deckIndex,
      decisions,
      insightPage,
      mode: mode === "start" ? "insights" : mode, // start doesn't make sense in restore
    };
    downloadJson("whiplash-progress.json", file);
  }

  function clickResumeUpload() {
    fileInputRef.current?.click();
  }

  async function onResumeFileSelected(file: File | null) {
    if (!file) return;
    setError(null);

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      if (!isProgressFileV1(parsed)) {
        throw new Error("Invalid progress file.");
      }

      const restored = parsed as ProgressFileV1;

      setData(restored.data);
      saveJSON(STORAGE_SNAPSHOT_KEY, restored.data);

      setDecisions(restored.decisions ?? {});
      saveJSON(STORAGE_DECISIONS_KEY, restored.decisions ?? {});

      const idx = safeNumber(restored.deckIndex, 0);
      setDeckIndex(idx);
      saveJSON(STORAGE_DECK_INDEX_KEY, idx);

      setInsightPage(safeNumber(restored.insightPage, 0));
      setMode(restored.mode === "deck" ? "deck" : "insights");
    } catch (e: any) {
      setError(e?.message || "Failed to import progress file.");
      setMode("start");
    } finally {
      // allow re-uploading same file
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // ---------------------------
  // PDF Export (pages 1-4 only)
  // ---------------------------
  function exportInsightsPDF() {
    if (!data) return;

    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const marginX = 48;
    const topY = 56;

    function title(t: string) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(18);
      doc.text(t, marginX, topY);
    }

    function subtitle(t: string, y: number) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.setTextColor(80);
      doc.text(t, marginX, y);
      doc.setTextColor(0);
    }

    // Page 1: Overview
    title("Whiplash — Spotify Snapshot");
    subtitle(new Date().toLocaleString(), topY + 18);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("Overview", marginX, topY + 48);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(12);

    const overviewRows = [
      ["Unique tracks", String(data.totals.totalUniqueTracks)],
      ["Unique artists", String(data.totals.totalArtists)],
      ["Playlists scanned", String(data.totals.totalPlaylists)],
    ];

    autoTable(doc, {
      startY: topY + 64,
      head: [["Metric", "Value"]],
      body: overviewRows,
      styles: { fontSize: 11 },
      headStyles: { fillColor: [20, 20, 30] },
      margin: { left: marginX, right: marginX },
    });

    // Page 2: Top 5 artists by songs
    doc.addPage();
    title("Top Artists by Songs");
    subtitle(`Based on ${data.totals.totalUniqueTracks} unique tracks`, topY + 18);

    autoTable(doc, {
      startY: topY + 46,
      head: [["Artist", "# Songs", "% of songs"]],
      body: topSongs.map((x) => [x.artistName, String(x.value), `${pct1(x.percent)}%`]),
      styles: { fontSize: 11 },
      headStyles: { fillColor: [20, 20, 30] },
      margin: { left: marginX, right: marginX },
    });

    // Page 3: Top 5 artists by playlists
    doc.addPage();
    title("Top Artists by Playlists");
    subtitle(`Based on ${data.totals.totalPlaylists} playlists`, topY + 18);

    autoTable(doc, {
      startY: topY + 46,
      head: [["Artist", "# Playlists", "% of playlists"]],
      body: topPlaylists.map((x) => [x.artistName, String(x.value), `${pct1(x.percent)}%`]),
      styles: { fontSize: 11 },
      headStyles: { fillColor: [20, 20, 30] },
      margin: { left: marginX, right: marginX },
    });

    // Page 4: Top 5 tracks by playlists
    doc.addPage();
    title("Top Tracks by Playlist Presence");
    subtitle(`Based on ${data.totals.totalPlaylists} playlists`, topY + 18);

    autoTable(doc, {
      startY: topY + 46,
      head: [["Track", "Main artist", "# Playlists", "% of playlists"]],
      body: topTracks.map((t) => [
        t.trackName,
        t.mainArtistName,
        String(t.playlistCount),
        `${pct1(t.percent)}%`,
      ]),
      styles: { fontSize: 11 },
      headStyles: { fillColor: [20, 20, 30] },
      margin: { left: marginX, right: marginX },
      columnStyles: { 0: { cellWidth: 240 }, 1: { cellWidth: 160 } },
    });

    const blob = doc.output("blob");
    downloadBlob("whiplash-insights.pdf", blob);
  }

  function exportSeenNotSeenPDF() {
    if (!data) return;

    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const marginX = 48;
    const topY = 56;

    function title(t: string) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(18);
      doc.text(t, marginX, topY);
    }

    function subtitle(t: string, y: number) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.setTextColor(80);
      doc.text(t, marginX, y);
      doc.setTextColor(0);
    }

    title("Whiplash — Live Shows Checklist");
    subtitle(new Date().toLocaleString(), topY + 18);
    subtitle(
      `Playlists scanned: ${data.totals.totalPlaylists} • Unique artists: ${data.totals.totalArtists}`,
      topY + 34
    );

    // Helper to print a section with autotable and return last Y
    function sectionTable(opts: {
      heading: string;
      rows: Array<{ artistName: string; trackCount: number }>;
      startY: number;
    }) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.text(opts.heading, marginX, opts.startY);

      autoTable(doc, {
        startY: opts.startY + 12,
        head: [["Artist", "Unique songs in playlists"]],
        body: opts.rows.map((r) => [r.artistName, String(r.trackCount)]),
        styles: { fontSize: 11 },
        headStyles: { fillColor: [20, 20, 30] },
        margin: { left: marginX, right: marginX },
        // Keeps long names readable
        columnStyles: { 0: { cellWidth: 320 }, 1: { cellWidth: 160 } },
      });

      return (doc as any).lastAutoTable?.finalY ?? opts.startY + 60;
    }

    // Seen section
    let y = topY + 70;
    y = sectionTable({
      heading: `Seen (${seenArtists.length})`,
      rows: seenArtists,
      startY: y,
    });

    // If there's not enough space for the next section title + a few rows, start a new page
    const pageHeight = doc.internal.pageSize.getHeight();
    if (y > pageHeight - 140) {
      doc.addPage();
      y = topY;
    } else {
      y += 28;
    }

    // Not seen section
    sectionTable({
      heading: `Not seen (${notSeenArtists.length})`,
      rows: notSeenArtists,
      startY: y,
    });

    const blob = doc.output("blob");
    downloadBlob("whiplash-live-status.pdf", blob);
  }


  // ---------------------------
  // Insights navigation
  // ---------------------------
  function nextInsight() {
    setInsightPage((p) => Math.min(insightTotalPages - 1, p + 1));
  }
  function prevInsight() {
    setInsightPage((p) => Math.max(0, p - 1));
  }

  // ---------------------------
  // Table sorting
  // ---------------------------
  const [sortKey, setSortKey] = useState<
    "artistName" | "songCount" | "songPercent" | "playlistCount" | "playlistPercent"
  >("songCount");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const sortedTable = useMemo(() => {
    const rows = [...table];
    rows.sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      const av: any = (a as any)[sortKey];
      const bv: any = (b as any)[sortKey];
      if (sortKey === "artistName") return dir * String(av).localeCompare(String(bv));
      return dir * (Number(av) - Number(bv));
    });
    return rows;
  }, [table, sortKey, sortDir]);

  function toggleSort(k: typeof sortKey) {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  }

  // ---------------------------
  // Deck logic (uses alphabetical array)
  // ---------------------------
  const seenArtists = useMemo(() => {
    return deckArtistsSorted
      .filter((a) => decisions[a.artistId] === true)
      .map((a) => ({
        artistName: a.artistName,
        trackCount: a.trackCount,
      }));
  }, [deckArtistsSorted, decisions]);

const notSeenArtists = useMemo(() => {
    return deckArtistsSorted
      .filter((a) => decisions[a.artistId] === false)
      .map((a) => ({
        artistName: a.artistName,
        trackCount: a.trackCount,
      }));
  }, [deckArtistsSorted, decisions]);

  const deckDone = deckIndex >= deckArtistsSorted.length;

  const deckStats = useMemo(() => {
    const total = deckArtistsSorted.length;
    let seen = 0;
    let notSeen = 0;

    for (const a of deckArtistsSorted) {
      const v = decisions[a.artistId];
      if (v === true) seen += 1;
      else if (v === false) notSeen += 1;
    }
    const decided = seen + notSeen;
    const remaining = total - decided;

    const pct = (x: number) => (total > 0 ? Math.round((x / total) * 1000) / 10 : 0);

    return { total, seen, notSeen, remaining, seenPct: pct(seen), notSeenPct: pct(notSeen) };
  }, [deckArtistsSorted, decisions]);

  function saveDecision(artistId: string, value: boolean) {
    setDecisions((prev) => {
      const next = { ...prev, [artistId]: value };
      saveJSON(STORAGE_DECISIONS_KEY, next);
      return next;
    });
  }

  function advanceDeck() {
    setDeckIndex((prev) => {
      const next = prev + 1;
      saveJSON(STORAGE_DECK_INDEX_KEY, next);
      return next;
    });
  }

  function markCurrent(value: boolean) {
    const cur = deckArtistsSorted[deckIndex];
    if (!cur) return;
    saveDecision(cur.artistId, value);
    advanceDeck();
  }

  function undoDeck() {
    setDeckIndex((prev) => {
      const next = Math.max(0, prev - 1);
      saveJSON(STORAGE_DECK_INDEX_KEY, next);
      return next;
    });
  }

  function resetDeck() {
    localStorage.removeItem(STORAGE_DECISIONS_KEY);
    localStorage.removeItem(STORAGE_DECK_INDEX_KEY);
    setDecisions({});
    setDeckIndex(0);
  }

  const swipeHandlers = useSwipeable({
    onSwipedLeft: () => markCurrent(false),
    onSwipedRight: () => markCurrent(true),
    trackMouse: true,
    preventScrollOnSwipe: true,
  });

  // Keyboard shortcuts for deck
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (mode !== "deck") return;
      if (loadingScan || !data) return;
      if (e.key === "ArrowLeft") markCurrent(false);
      if (e.key === "ArrowRight") markCurrent(true);
      if (e.key === "Backspace") undoDeck();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, loadingScan, data, deckIndex, deckArtistsSorted]);

  const showLoading = loadingScan;

  return (
    <main style={{ ...styles.page, padding: isMobile ? 12 : 20 }}>
      {/* Hidden file input for resume */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json"
        style={{ display: "none" }}
        onChange={(e) => onResumeFileSelected(e.target.files?.[0] ?? null)}
      />

      {showLoading && (
        <div style={styles.loadingOverlay}>
          <img
            src="/dance.gif"
            alt="Loading"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
            style={{
              width: "min(320px, 60vw)",
              height: "min(320px, 60vw)",
              objectFit: "contain",
              filter: "drop-shadow(0 10px 30px rgba(0,0,0,0.4))",
            }}
          />
          <div style={{ marginTop: 18, fontWeight: 900, fontSize: 17 }}>Scanning your Spotify…</div>
          <div style={{ marginTop: 6, opacity: 0.8, fontSize: 13 }}>
            This can take a bit if you have many playlists.
          </div>
        </div>
      )}

      <header style={{ ...styles.header, ...(isMobile ? styles.headerMobile : null) }}>
        <div>
          <div style={styles.title}>Whiplash</div>
        </div>

        <div style={{ ...styles.headerRight, ...(isMobile ? styles.headerRightMobile : null) }}>
          <button style={{ ...styles.smallBtn, ...(isMobile ? styles.smallBtnMobile : null) }} onClick={exportProgress} disabled={!data}>
            Save progress
          </button>
          <button style={{ ...styles.smallBtn, ...(isMobile ? styles.smallBtnMobile : null) }} onClick={clickResumeUpload}>
            Resume
          </button>
          <a href="/api/auth/login" style={styles.link}>
            Re-login
          </a>
          <button style={{ ...styles.smallBtn, ...(isMobile ? styles.smallBtnMobile : null) }} onClick={scanSpotify} disabled={loadingScan}>
            Scan Spotify
          </button>
        </div>
      </header>

      {error && (
        <div style={styles.card}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>Error</div>
          <code>{error}</code>
          <div style={{ marginTop: 10, opacity: 0.8, fontSize: 13 }}>
            If this says <b>not_authenticated</b>, open the site on{" "}
            <b>http://127.0.0.1:3000</b> and log in from there.
          </div>
        </div>
      )}

      {/* START SCREEN */}
      {mode === "start" && (
        <section style={{ ...styles.cardBig, textAlign: "center" }}>
          <div style={{ fontSize: 26, fontWeight: 950, letterSpacing: -0.4 }}>Welcome to Whiplash</div>
          <div style={{ marginTop: 10, opacity: 0.8 }}>
            Connect Spotify to scan your playlists, or resume from a saved progress file.
          </div>

          <div style={{ marginTop: 18, display: "flex", justifyContent: "center", gap: 10, flexWrap: "wrap" }}>
            <button style={{ ...styles.btnYes, ...(isMobile ? styles.deckBtnMobile : null) }} onClick={scanSpotify} disabled={loadingScan}>
              Connect Spotify
            </button>
            <button style={{ ...styles.smallBtn, ...(isMobile ? styles.smallBtnMobile : null) }} onClick={clickResumeUpload}>
              Resume (upload JSON)
            </button>
          </div>

          <div style={{ marginTop: 14, opacity: 0.7, fontSize: 12 }}>
            Tip: after scanning, use <b>Save progress</b> to continue later without Spotify.
          </div>
        </section>
      )}

      {/* INSIGHTS */}
      {data && mode === "insights" && (
        <>
          <section style={styles.modeBar}>
            <div style={styles.dots}>
              {Array.from({ length: insightTotalPages }).map((_, i) => (
                <button
                  key={i}
                  onClick={() => setInsightPage(i)}
                  style={{ ...styles.dot, opacity: i === insightPage ? 1 : 0.35 }}
                  aria-label={`Go to insight page ${i + 1}`}
                />
              ))}
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button style={{ ...styles.smallBtn, ...(isMobile ? styles.smallBtnMobile : null) }} onClick={exportInsightsPDF}>
                Save insights (PDF)
              </button>
              <button style={{ ...styles.btnYes, ...(isMobile ? styles.deckBtnMobile : null) }} onClick={() => setMode("deck")}>
                Start swiping →
              </button>
            </div>
          </section>

          <section style={styles.cardBig}>
            {insightPage === 0 && (
              <>
                <div style={styles.h1}>Overview</div>
                <div style={styles.kpiGrid}>
                  <Kpi label="Unique tracks" value={totals?.totalUniqueTracks ?? 0} />
                  <Kpi label="Unique artists" value={totals?.totalArtists ?? 0} />
                  <Kpi label="Playlists scanned" value={totals?.totalPlaylists ?? 0} />
                </div>
              </>
            )}

            {insightPage === 1 && (
              <>
                <div style={styles.h1}>Top 5 artists by songs</div>
                <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                  {topSongs.map((x) => (
                    <div key={x.artistId} style={{ ...styles.row, ...(isMobile ? styles.rowMobile : null), alignItems: "center" }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        <Avatar url={x.imageUrl} size={34} />
                        <div style={{ fontWeight: 900 }}>{x.artistName}</div>
                      </div>
                      <div style={{ opacity: 0.85, ...(isMobile ? { width: "100%" } : null) }}>
                        {x.value} • {pct1(x.percent)}%
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {insightPage === 2 && (
              <>
                <div style={styles.h1}>Top 5 artists by playlists</div>
                <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                  {topPlaylists.map((x) => (
                    <div key={x.artistId} style={{ ...styles.row, ...(isMobile ? styles.rowMobile : null), alignItems: "center" }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        <Avatar url={x.imageUrl} size={34} />
                        <div style={{ fontWeight: 900 }}>{x.artistName}</div>
                      </div>
                      <div style={{ opacity: 0.85, ...(isMobile ? { width: "100%" } : null) }}>
                        {x.value} • {pct1(x.percent)}%
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {insightPage === 3 && (
              <>
                <div style={styles.h1}>Top 5 tracks by playlist presence</div>
                <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                  {topTracks.map((t) => (
                    <div key={t.trackId} style={{ ...styles.row, ...(isMobile ? styles.rowMobile : null), alignItems: "center" }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        <Avatar url={t.mainArtistImageUrl} size={34} />
                        <div>
                          <div style={{ fontWeight: 900 }}>{t.trackName}</div>
                          <div style={{ opacity: 0.75, fontSize: 12 }}>{t.mainArtistName}</div>
                        </div>
                      </div>
                      <div style={{ opacity: 0.85, ...(isMobile ? { width: "100%" } : null) }}>
                        {t.playlistCount} • {pct1(t.percent)}%
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {insightPage === 4 && (
              <>
                <div style={styles.h1}>All artists (sortable)</div>
                <div style={{ opacity: 0.8, fontSize: 13, marginBottom: 10 }}>
                  Tap a column header to sort. Table is not included in PDF export.
                </div>

                <div style={styles.tableWrap}>
                  <table style={{ ...styles.table, ...(isMobile ? styles.tableMobile : null) }}>
                    <thead>
                      <tr>
                        <Th isMobile={isMobile} onClick={() => toggleSort("artistName")} active={sortKey === "artistName"}>
                          Artist {sortKey === "artistName" ? (sortDir === "asc" ? "▲" : "▼") : ""}
                        </Th>
                        <Th isMobile={isMobile}onClick={() => toggleSort("songCount")} active={sortKey === "songCount"}>
                          # songs {sortKey === "songCount" ? (sortDir === "asc" ? "▲" : "▼") : ""}
                        </Th>
                        <Th isMobile={isMobile} onClick={() => toggleSort("songPercent")} active={sortKey === "songPercent"}>
                          % songs {sortKey === "songPercent" ? (sortDir === "asc" ? "▲" : "▼") : ""}
                        </Th>
                        <Th isMobile={isMobile} onClick={() => toggleSort("playlistCount")} active={sortKey === "playlistCount"}>
                          # playlists {sortKey === "playlistCount" ? (sortDir === "asc" ? "▲" : "▼") : ""}
                        </Th>
                        <Th isMobile={isMobile} onClick={() => toggleSort("playlistPercent")} active={sortKey === "playlistPercent"}>
                          % playlists {sortKey === "playlistPercent" ? (sortDir === "asc" ? "▲" : "▼") : ""}
                        </Th>
                      </tr>
                    </thead>

                    <tbody>
                      <tr style={{ fontWeight: 950 }}>
                        <td>Total</td>
                        <td>{totals?.totalUniqueTracks ?? 0}</td>
                        <td>100%</td>
                        <td>{totals?.totalPlaylists ?? 0}</td>
                        <td>100%</td>
                      </tr>

                      {sortedTable.map((r) => (
                        <tr key={r.artistId}>
                          <td style={{ display: "flex", gap: 10, alignItems: "center" }}>
                            <Avatar url={r.imageUrl} size={22} />
                            <span>{r.artistName}</span>
                          </td>
                          <td>{r.songCount}</td>
                          <td>{pct1(r.songPercent)}%</td>
                          <td>{r.playlistCount}</td>
                          <td>{pct1(r.playlistPercent)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>

          <section style={styles.navRow}>
            <button style={{ ...styles.smallBtn, ...(isMobile ? styles.smallBtnMobile : null) }} onClick={prevInsight} disabled={insightPage === 0}>
              ← Back
            </button>
            <button style={{ ...styles.smallBtn, ...(isMobile ? styles.smallBtnMobile : null) }} onClick={nextInsight} disabled={insightPage === insightTotalPages - 1}>
              Next →
            </button>
          </section>
        </>
      )}

      {/* DECK */}
      {data && mode === "deck" && (
        <>
          <section style={{ ...styles.statsRow, ...(isMobile ? styles.statsRowMobile : null) }}>
            <Stat label="Artists" value={deckStats.total} />
            <Stat label="Seen" value={`${deckStats.seen} (${deckStats.seenPct}%)`} />
            <Stat label="Not seen" value={`${deckStats.notSeen} (${deckStats.notSeenPct}%)`} />
            <Stat label="Remaining" value={deckStats.remaining} />
          </section>

          {!deckDone ? (
            <section
              style={{
                ...styles.deckWrap,
                paddingBottom: isMobile ? 84 : 0,
              }}
            >
              <div style={styles.progress}>
                {deckIndex + 1} / {deckArtistsSorted.length} (A–Z)
              </div>

              <div {...swipeHandlers} style={styles.cardBig}>
                <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
                  <Avatar url={deckArtistsSorted[deckIndex]?.imageUrl} size={isMobile ? 92 : 110} />
                </div>

                <div style={{ ...styles.artistName, fontSize: isMobile ? 22 : 26 }}>{deckArtistsSorted[deckIndex]?.artistName}</div>
                <div style={styles.trackCount}>
                  {deckArtistsSorted[deckIndex]?.trackCount} unique songs in your playlists
                </div>

                <div style={styles.hintRow}>
                  <span style={styles.hintLeft}>← Not seen</span>
                  <span style={styles.hintRight}>Seen →</span>
                </div>
              </div>

              <div style={{ ...styles.btnRow, ...(isMobile ? styles.deckBottomBar : null) }}>
                <button style={{ ...styles.btnNo, ...(isMobile ? styles.deckBtnMobile : null) }} onClick={() => markCurrent(false)}>
                  Not seen (←)
                </button>
                <button style={{ ...styles.btnUndo, ...(isMobile ? styles.deckBtnMobile : null) }} onClick={undoDeck} disabled={deckIndex === 0}>
                  Undo (⌫)
                </button>
                <button style={{ ...styles.btnYes, ...(isMobile ? styles.deckBtnMobile : null) }} onClick={() => markCurrent(true)}>
                  Seen (→)
                </button>
              </div>

              <div style={{ marginTop: 10 }}>
                <button style={{ ...styles.smallBtn, ...(isMobile ? styles.smallBtnMobile : null) }} onClick={() => setMode("insights")}>
                  ← Back to insights
                </button>
                <button style={{ ...styles.smallBtn, marginLeft: 10 }} onClick={resetDeck}>
                  Reset swipes
                </button>
              </div>
            </section>
          ) : (
            <section style={styles.card}>
              <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 8 }}>Done 🎉</div>
              <div style={{ marginBottom: 14 }}>
                Seen: <b>{deckStats.seen}</b> • Not seen: <b>{deckStats.notSeen}</b> • Total:{" "}
                <b>{deckStats.total}</b>
              </div>
              <div style={{ ...styles.btnRow, ...(isMobile ? styles.deckBottomBar : null) }}>
                <button style={{ ...styles.btnUndo, ...(isMobile ? styles.deckBtnMobile : null) }} onClick={undoDeck} disabled={deckArtistsSorted.length === 0}>
                  Review last
                </button>

                <button style={{ ...styles.smallBtn, ...(isMobile ? styles.smallBtnMobile : null) }} onClick={exportSeenNotSeenPDF}>
                  Download seen / not seen (PDF)
                </button>

                <button style={{ ...styles.btnNo, ...(isMobile ? styles.deckBtnMobile : null) }} onClick={resetDeck}>
                  Reset swipes
                </button>
              </div>

            </section>
          )}

        </>
      )}
    </main>
  );
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div style={styles.kpiBox}>
      <div style={styles.kpiLabel}>{label}</div>
      <div style={styles.kpiValue}>{value}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={styles.statBox}>
      <div style={styles.statLabel}>{label}</div>
      <div style={styles.statValue}>{value}</div>
    </div>
  );
}

function Avatar({ url, size }: { url?: string | null; size: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.18)",
        background: "rgba(255,255,255,0.06)",
        flex: "0 0 auto",
      }}
    >
      {url ? (
        <img
          src={url}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          referrerPolicy="no-referrer"
        />
      ) : (
        <div style={{ width: "100%", height: "100%" }} />
      )}
    </div>
  );
}

function Th({
  children,
  onClick,
  active,
  isMobile,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  isMobile?: boolean;
}) {
  return (
    <th
      onClick={onClick}
      style={{
        ...styles.th,
        ...(isMobile ? { padding: "8px 8px", fontSize: 12 } : null),
        opacity: active ? 1 : 0.85,
      }}
    >
      {children}
    </th>
  );
}


const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    padding: 20,
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
    background: "#0b0b0f",
    color: "#fff",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "flex-start",
    marginBottom: 16,
    flexWrap: "wrap",
  },

  headerMobile: {
    position: "sticky",
    top: 0,
    zIndex: 50,
    padding: 12,
    margin: -20,
    marginBottom: 12,
    background: "rgba(11,11,15,0.85)",
    backdropFilter: "blur(10px)",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
  },
  title: { fontSize: 22, fontWeight: 900, letterSpacing: -0.3 },
  subtitle: { opacity: 0.8, marginTop: 4, fontSize: 13 },
  headerRight: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },

  headerRightMobile: {
    width: "100%",
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
    alignItems: "stretch",
  },
  link: { color: "#9ad", textDecoration: "none", fontSize: 13 },

  modeBar: {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    alignItems: "center",
    flexWrap: "wrap",
    marginBottom: 10,
  },
  dots: { display: "flex", gap: 6, alignItems: "center" },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.25)",
    background: "rgba(255,255,255,0.25)",
    cursor: "pointer",
  },

  smallBtn: {
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.15)",
    background: "rgba(255,255,255,0.06)",
    color: "#fff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 800,
  },

  smallBtnMobile: {
    padding: "12px 12px",
    borderRadius: 14,
    fontSize: 14,
    width: "100%",
  },

  deckBtnMobile: {
    padding: "14px 14px",
    borderRadius: 16,
    fontSize: 15,
    flex: 1,
    minWidth: 0,
  },

  statsRow: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 10,
    marginBottom: 16,
  },

  statsRowMobile: {
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 8,
    marginBottom: 12,
  },

  statBox: {
    borderRadius: 14,
    padding: 12,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.04)",
  },
  statLabel: { opacity: 0.75, fontSize: 12, marginBottom: 6 },
  statValue: { fontSize: 16, fontWeight: 900 },

  card: {
    borderRadius: 18,
    padding: 16,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.04)",
    maxWidth: 720,
    margin: "0 auto",
  },
  cardBig: {
    width: "min(820px, 96vw)",
    borderRadius: 22,
    padding: 18,
    border: "1px solid rgba(255,255,255,0.14)",
    background:
      "linear-gradient(135deg, rgba(255,255,255,0.07), rgba(255,255,255,0.02))",
    boxShadow: "0 10px 40px rgba(0,0,0,0.45)",
    margin: "0 auto",
  },

  h1: { fontSize: 20, fontWeight: 900, letterSpacing: -0.2 },

  // vertical KPIs
  kpiGrid: {
    marginTop: 14,
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: 10,
  },
  kpiBox: {
    borderRadius: 14,
    padding: 12,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(0,0,0,0.25)",
  },
  kpiLabel: { opacity: 0.75, fontSize: 12, marginBottom: 6, fontWeight: 800 },
  kpiValue: { fontSize: 20, fontWeight: 950 },

  row: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(0,0,0,0.22)",
  },

  navRow: {
    display: "flex",
    justifyContent: "space-between",
    maxWidth: 820,
    margin: "12px auto 0",
  },

  tableWrap: {
    marginTop: 10,
    maxHeight: "52vh",
    overflow: "auto",
    WebkitOverflowScrolling: "touch",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(0,0,0,0.20)",
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },

  tableMobile: { fontSize: 12 },

  th: {
    position: "sticky",
    top: 0,
    background: "rgba(15,15,22,0.98)",
    textAlign: "left",
    padding: "10px 10px",
    cursor: "pointer",
    borderBottom: "1px solid rgba(255,255,255,0.12)",
    fontWeight: 950,
    whiteSpace: "nowrap",
  },

  deckWrap: { display: "flex", flexDirection: "column", gap: 12, alignItems: "center" },
  progress: { opacity: 0.8, fontSize: 13 },

  artistName: { fontSize: 26, fontWeight: 900, letterSpacing: -0.4, textAlign: "center" },
  trackCount: { opacity: 0.85, marginTop: 10, textAlign: "center" },

  hintRow: {
    display: "flex",
    justifyContent: "space-between",
    marginTop: 18,
    opacity: 0.7,
    fontSize: 12,
  },

  deckBottomBar: {
    position: "fixed",
    left: 0,
    right: 0,
    bottom: 0,
    padding: 12,
    background: "rgba(11,11,15,0.9)",
    backdropFilter: "blur(12px)",
    borderTop: "1px solid rgba(255,255,255,0.10)",
    gap: 10,
    zIndex: 60,
  },


  btnRow: { display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" },
  btnNo: {
    padding: "10px 14px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.06)",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 950,
  },
  btnYes: {
    padding: "10px 14px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.14)",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 950,
  },
  btnUndo: {
    padding: "10px 14px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(0,0,0,0.2)",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 900,
  },

  footerNote: { marginTop: 18, textAlign: "center", opacity: 0.65, fontSize: 12 },

  loadingOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.75)",
    display: "grid",
    placeItems: "center",
    zIndex: 999,
    padding: 20,
    textAlign: "center",
  },
};
