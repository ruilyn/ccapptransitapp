// api/subway.js
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

// MTA GTFS-RT feed endpoints (no API key required for public feeds)
const FEEDS = [
  "https://gtfsrt.prod.obanyc.com/tripUpdates",
  // "https://gtfsrt.prod.obanyc.com/vehiclePositions",
  // "https://gtfsrt.prod.obanyc.com/alerts",
];

export default async function handler(req, res) {
  try {
    const results = await Promise.all(
      FEEDS.map(async (url) => {
        const r = await fetch(url, { cache: "no-store" });

        if (!r.ok) {
          return {
            url,
            ok: false,
            status: r.status,
            error: `Upstream HTTP ${r.status}`,
          };
        }

        const arr = new Uint8Array(await r.arrayBuffer());
        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(arr);

        return {
          url,
          ok: true,
          header: feed.header || null,
          entityCount: Array.isArray(feed.entity) ? feed.entity.length : 0,
          entities: (feed.entity || []).slice(0, 200), // cap payload
        };
      })
    );

    const okCount = results.filter((x) => x.ok).length;

    return res.status(200).json({
      ok: okCount > 0,
      fetchedAt: new Date().toISOString(),
      feeds: results,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || "Unknown error",
    });
  }
}
