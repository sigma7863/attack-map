# Internet Attack Map

## Backend (TypeScript)

```bash
cd /Users/sigma7863/Documents/attack-map/backend
pnpm install
# GeoLite2-City.mmdb を配置したうえで
GEOIP_DB_PATH=./GeoLite2-City.mmdb LOG_PATH=./sample.log.jsonl pnpm dev
```

## Frontend (Next.js + MapLibre)

```bash
cd /Users/sigma7863/Documents/attack-map/frontend
pnpm install
NEXT_PUBLIC_WS_URL=ws://localhost:4000/ws pnpm dev
```

## Env

- `GEOIP_DB_PATH`: GeoLite2 City DB ファイル
- `LOG_PATH`: JSON Lines のログファイル (省略時は stdin)
- `SITE_MAP_PATH`: `sites.json` パス
- `NEXT_PUBLIC_WS_URL`: WebSocket URL
- `NEXT_PUBLIC_MAP_STYLE_URL`: MapLibre スタイルURL (デフォルトはダーク)
- `NEXT_PUBLIC_MAP_TILE_URL`: タイル URL テンプレート (指定時はラスタ)
