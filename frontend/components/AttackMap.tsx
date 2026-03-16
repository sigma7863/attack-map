"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { Map, GeoJSONSource } from "maplibre-gl";
import type { Feature, LineString, Point } from "geojson";

type EventPayload = {
  id: string;
  ts: string;
  src: { ip: string; lat: number | null; lng: number | null; country: string | null };
  dst: { siteId: string; lat: number; lng: number; label: string };
  type: string;
  meta: { port: number | null; proto: string | null };
};

type WsMessage =
  | { type: "hello"; ts: string }
  | { type: "event"; data: EventPayload };

const ATTACK_COLORS: Record<string, string> = {
  "port-scan": "#f97316",
  login: "#38bdf8",
  exploit: "#f87171",
  ddos: "#a855f7",
  malware: "#22c55e",
  unknown: "#94a3b8"
};

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:4000/ws";
const MAP_STYLE_URL =
  process.env.NEXT_PUBLIC_MAP_STYLE_URL ||
  "https://demotiles.maplibre.org/style.json";
const MAP_TILE_URL = process.env.NEXT_PUBLIC_MAP_TILE_URL || "";

const MAX_AGE_MS = 12000;
const REFRESH_MS = 500;

export default function AttackMap() {
  const mapRef = useRef<Map | null>(null);
  const eventsRef = useRef<EventPayload[]>([]);
  const [connection, setConnection] = useState<"connecting" | "open" | "closed" | "error">("connecting");

  const legendItems = useMemo(() => {
    return Object.keys(ATTACK_COLORS).map((key) => ({
      key,
      color: ATTACK_COLORS[key]
    }));
  }, []);

  useEffect(() => {
    const style = MAP_TILE_URL
      ? ({
          version: 8,
          sources: {
            raster: {
              type: "raster",
              tiles: [MAP_TILE_URL],
              tileSize: 256
            }
          },
          layers: [
            {
              id: "raster",
              type: "raster",
              source: "raster"
            }
          ]
        } as maplibregl.StyleSpecification)
      : MAP_STYLE_URL;

    const map = new maplibregl.Map({
      container: "map",
      style,
      center: [10, 20],
      zoom: 1.3,
      maxZoom: 6,
      minZoom: 1
    });

    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-left");

    map.on("load", () => {
      map.addSource("arcs", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] }
      });

      map.addSource("pulses", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] }
      });

      map.addLayer({
        id: "arcs",
        type: "line",
        source: "arcs",
        paint: {
          "line-color": ["get", "color"],
          "line-width": 1.6,
          "line-opacity": ["get", "opacity"]
        }
      });

      map.addLayer({
        id: "pulses",
        type: "circle",
        source: "pulses",
        paint: {
          "circle-radius": ["get", "radius"],
          "circle-color": ["get", "color"],
          "circle-opacity": ["get", "opacity"],
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-width": 1
        }
      });
    });

    return () => {
      map.remove();
    };
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const connect = () => {
      setConnection("connecting");
      ws = new WebSocket(WS_URL);

      ws.onopen = () => setConnection("open");
      ws.onclose = () => setConnection("closed");
      ws.onerror = () => setConnection("error");
      ws.onmessage = (event) => {
        try {
          const msg: WsMessage = JSON.parse(event.data);
          if (msg.type === "event") {
            const data = msg.data;
            eventsRef.current.push(data);
          }
        } catch {
          // ignore malformed payloads
        }
      };
    };

    connect();

    intervalId = setInterval(() => {
      const now = Date.now();
      eventsRef.current = eventsRef.current.filter((evt) => {
        const age = now - new Date(evt.ts).getTime();
        return age <= MAX_AGE_MS;
      });
      updateLayers(eventsRef.current, mapRef.current, now);
    }, REFRESH_MS);

    return () => {
      if (intervalId) clearInterval(intervalId);
      if (ws) ws.close();
    };
  }, []);

  return (
    <div className="map-shell">
      <div id="map" className="map-container" />
      <div className="panel legend">
        <h3>Attack Types</h3>
        {legendItems.map((item) => (
          <div className="legend-row" key={item.key}>
            <span className="legend-swatch" style={{ background: item.color }} />
            <span>{item.key}</span>
          </div>
        ))}
      </div>
      <div className="panel status">
        <span
          className={`status-dot ${
            connection === "open"
              ? "status-ok"
              : connection === "connecting"
              ? "status-warn"
              : "status-err"
          }`}
        />
        <span>WS: {connection}</span>
      </div>
    </div>
  );
}

function updateLayers(events: EventPayload[], map: Map | null, now: number) {
  if (!map) return;
  if (!map.getSource("arcs") || !map.getSource("pulses")) return;

  const arcFeatures: Feature<LineString>[] = events
    .filter((evt) => evt.src.lat != null && evt.src.lng != null)
    .map((evt) => {
    const age = now - new Date(evt.ts).getTime();
    const opacity = Math.max(0.15, 1 - age / MAX_AGE_MS);
    const color = ATTACK_COLORS[evt.type] || ATTACK_COLORS.unknown;
    const coords = buildArc(
      [evt.src.lng as number, evt.src.lat as number],
      [evt.dst.lng, evt.dst.lat]
    );
    return {
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: { color, opacity }
    };
  });

  const pulseFeatures: Feature<Point>[] = events.map((evt) => {
    const age = now - new Date(evt.ts).getTime();
    const t = age / MAX_AGE_MS;
    const opacity = Math.max(0, 1 - t);
    const color = ATTACK_COLORS[evt.type] || ATTACK_COLORS.unknown;
    const radius = 4 + 18 * t;
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [evt.dst.lng, evt.dst.lat] },
      properties: { color, opacity, radius }
    };
  });

  (map.getSource("arcs") as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: arcFeatures
  });

  (map.getSource("pulses") as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: pulseFeatures
  });
}

function buildArc(start: [number, number], end: [number, number], segments = 30) {
  const coords: [number, number][] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const lng = start[0] + (end[0] - start[0]) * t;
    const lat = start[1] + (end[1] - start[1]) * t;
    const arcHeight = Math.sin(Math.PI * t) * 12;
    coords.push([lng, lat + arcHeight]);
  }
  return coords;
}
