import fs from "fs";
import readline from "readline";
import http from "http";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import maxmind from "maxmind";
import type { CityResponse, Reader } from "maxmind";
import ipaddr from "ipaddr.js";

const PORT = process.env.PORT || 4000;
const WS_PATH = "/ws";
const GEOIP_DB_PATH = process.env.GEOIP_DB_PATH || "./GeoLite2-City.mmdb";
const LOG_PATH = process.env.LOG_PATH || ""; // if empty, read from stdin
const SITE_MAP_PATH = process.env.SITE_MAP_PATH || "./sites.json";
const DEFAULT_SITE_ID = process.env.DEFAULT_SITE_ID || "tokyo";
const REPLAY_ON_CONNECT = process.env.REPLAY_ON_CONNECT !== "0";
const REPLAY_REWRITE_TS = process.env.REPLAY_REWRITE_TS !== "0";
const RECENT_MAX = Number(process.env.RECENT_MAX || 200);

type RawEvent = {
  ts?: string;
  src_ip?: string;
  srcIp?: string;
  source_ip?: string;
  dst_ip?: string;
  dstIp?: string;
  dest_ip?: string;
  type?: string;
  attack_type?: string;
  port?: number;
  proto?: string;
  protocol?: string;
};

type Site = {
  id: string;
  label: string;
  lat: number;
  lng: number;
};

type SiteMapFile = {
  sites: Record<string, Site>;
  cidrMap: [string, string][];
};

type CompiledSiteMap = {
  sites: Record<string, Site>;
  cidrMap: { cidr: string; siteId: string; range: [ipaddr.IPv4 | ipaddr.IPv6, number] }[];
};

type EventPayload = {
  id: string;
  ts: string;
  src: {
    ip: string;
    lat: number | null;
    lng: number | null;
    country: string | null;
  };
  dst: {
    siteId: string;
    lat: number;
    lng: number;
    label: string;
  };
  type: string;
  meta: {
    port: number | null;
    proto: string | null;
  };
};

let geoipReader: Reader<CityResponse> | null = null;
try {
  if (fs.existsSync(GEOIP_DB_PATH)) {
    geoipReader = await maxmind.open(GEOIP_DB_PATH);
    console.log(`[geoip] loaded ${GEOIP_DB_PATH}`);
  } else {
    console.warn(`[geoip] database not found at ${GEOIP_DB_PATH}`);
  }
} catch (err) {
  console.error("[geoip] failed to load database", err);
}

const siteMap = loadSiteMap(SITE_MAP_PATH);

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: WS_PATH });
const recentEvents: EventPayload[] = [];

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "hello", ts: new Date().toISOString() }));

  if (REPLAY_ON_CONNECT && recentEvents.length > 0) {
    const base = Date.now();
    recentEvents.forEach((evt, idx) => {
      const replayed = REPLAY_REWRITE_TS
        ? { ...evt, ts: new Date(base + idx * 40).toISOString() }
        : evt;
      ws.send(JSON.stringify({ type: "event", data: replayed }));
    });
  }
});

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}${WS_PATH}`);
  console.log(`[ingest] reading from ${LOG_PATH ? LOG_PATH : "stdin"}`);
});

const input = LOG_PATH ? fs.createReadStream(LOG_PATH, { encoding: "utf8" }) : process.stdin;
const rl = readline.createInterface({ input });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let parsed: RawEvent;
  try {
    parsed = JSON.parse(trimmed) as RawEvent;
  } catch (err) {
    console.warn("[ingest] invalid JSON", err);
    return;
  }

  const event = normalizeEvent(parsed, siteMap, geoipReader);
  if (!event) return;

  const payload = JSON.stringify({ type: "event", data: event });
  recentEvents.push(event);
  if (recentEvents.length > RECENT_MAX) {
    recentEvents.splice(0, recentEvents.length - RECENT_MAX);
  }
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
});

function normalizeEvent(raw: RawEvent, siteMapData: CompiledSiteMap, geoip: Reader<CityResponse> | null): EventPayload | null {
  const ts = raw.ts || new Date().toISOString();
  const srcIp = raw.src_ip || raw.srcIp || raw.source_ip;
  const dstIp = raw.dst_ip || raw.dstIp || raw.dest_ip;
  const attackType = raw.type || raw.attack_type || "unknown";
  const port = raw.port ?? null;
  const proto = raw.proto || raw.protocol || null;

  if (!srcIp) return null;

  const srcGeo = geoipLookup(srcIp, geoip);
  const dstSite = resolveSite(dstIp, siteMapData) || siteMapData.sites[DEFAULT_SITE_ID];
  if (!dstSite) return null;

  return {
    id: uuidv4(),
    ts,
    src: {
      ip: srcIp,
      lat: srcGeo?.lat ?? null,
      lng: srcGeo?.lng ?? null,
      country: srcGeo?.country ?? null
    },
    dst: {
      siteId: dstSite.id,
      lat: dstSite.lat,
      lng: dstSite.lng,
      label: dstSite.label
    },
    type: attackType,
    meta: {
      port,
      proto
    }
  };
}

function geoipLookup(ip: string, geoip: Reader<CityResponse> | null) {
  if (!geoip) return null;
  try {
    const res = geoip.get(ip);
    if (!res || !res.location) return null;
    return {
      lat: res.location.latitude,
      lng: res.location.longitude,
      country: res.country?.iso_code || null
    };
  } catch {
    return null;
  }
}

function loadSiteMap(path: string): CompiledSiteMap {
  const raw = fs.readFileSync(path, "utf8");
  const data = JSON.parse(raw) as SiteMapFile;
  const compiled = data.cidrMap.map((entry) => {
    const [cidr, siteId] = entry;
    return { cidr, siteId, range: ipaddr.parseCIDR(cidr) };
  });
  return { sites: data.sites, cidrMap: compiled };
}

function resolveSite(dstIp: string | undefined, siteMapData: CompiledSiteMap): Site | null {
  if (!dstIp) return null;
  try {
    const addr = ipaddr.parse(dstIp);
    for (const entry of siteMapData.cidrMap) {
      if (addr.match(entry.range)) {
        return siteMapData.sites[entry.siteId] || null;
      }
    }
  } catch {
    return null;
  }
  return null;
}
