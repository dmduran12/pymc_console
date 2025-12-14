# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

pymc_console is a Next.js dashboard and installer for [pyMC_Repeater](https://github.com/rightup/pyMC_Repeater), a LoRa mesh network repeater built on [pymc_core](https://github.com/rightup/pyMC_core). It provides:

- **Next.js Dashboard** - Real-time monitoring of packets, neighbors, stats, and radio config
- **manage.sh Installer** - TUI-based installer/upgrader with whiptail/dialog interface
- **Static Export** - Dashboard served directly by pyMC_Repeater's CherryPy backend (no Node.js server needed in production)

## Tech Stack

- **Frontend**: Next.js 16, React 19, TypeScript, Tailwind CSS 4
- **State Management**: Zustand
- **Charts**: Recharts
- **Maps**: Leaflet / react-leaflet
- **Icons**: lucide-react
- **Installer**: Bash with whiptail/dialog TUI
- **Monitoring**: Grafana + Prometheus (optional Docker stack)

## Repository Structure

```
pymc_console/
├── frontend/              # Next.js dashboard (static export)
│   ├── src/               # Source code
│   └── out/               # Built static files (after npm run build)
├── manage.sh              # Main installer/manager script (TUI)
├── install.sh             # Legacy installer (deprecated)
├── monitoring/            # Grafana + Prometheus configs
├── docker-compose.yml     # Container orchestration
└── nextjs-static-serving.patch  # Upstream patch for pyMC_Repeater
```

## Development Commands

```bash
# Frontend development (from frontend/)
cd frontend
npm install        # Install dependencies
npm run dev        # Start dev server at http://localhost:3000
npm run build      # Production build → frontend/out/ (static export)
npm run lint       # Run ESLint

# Installer (run as root on target Pi)
sudo ./manage.sh            # TUI menu
sudo ./manage.sh install    # Non-interactive install
sudo ./manage.sh upgrade    # Upgrade existing installation
```

## Architecture

### Deployment Model

The dashboard is a **static export** (`output: 'export'` in next.config.ts). After `npm run build`:
1. Static HTML/JS/CSS is generated in `frontend/out/`
2. `manage.sh` copies these to pyMC_Repeater's `repeater/web/html/` directory
3. pyMC_Repeater's CherryPy server serves the dashboard at port 8000
4. No separate frontend server needed in production

### Installation Paths (on target device)

- `/opt/pymc_console/` - Main install directory
- `/opt/pymc_console/pymc_repeater/` - Cloned pyMC_Repeater repo
- `/opt/pymc_console/venv/` - Python virtual environment
- `/etc/pymc_repeater/config.yaml` - Radio and repeater configuration
- `/var/log/pymc_repeater/` - Log files
- Systemd service: `pymc-repeater.service`

### Frontend Structure (`frontend/src/`)

```
src/
├── app/                    # Next.js App Router pages
│   ├── page.tsx           # Dashboard home
│   ├── packets/page.tsx   # Packet history & filtering
│   ├── neighbors/page.tsx # Neighbor map & list
│   ├── statistics/page.tsx # Charts & metrics
│   ├── logs/page.tsx      # System logs
│   ├── settings/page.tsx  # Radio configuration
│   └── system/page.tsx    # Hardware stats
├── components/
│   ├── charts/            # AirtimeGauge, PacketTypesChart, TrafficStackedChart, NeighborPolarChart
│   ├── controls/          # ControlPanel (mode/duty cycle)
│   ├── layout/            # Sidebar, Header, BackgroundProvider
│   ├── neighbors/         # NeighborMap, NeighborMapWrapper (Leaflet)
│   ├── packets/           # PacketRow, PacketDetailModal, RecentPackets
│   ├── shared/            # TimeRangeSelector, BackgroundSelector
│   ├── stats/             # StatsCard
│   └── ui/                # HashBadge
├── lib/
│   ├── api.ts             # All API client functions (typed fetch wrappers)
│   ├── constants.ts       # App constants
│   ├── format.ts          # Formatting utilities
│   ├── packet-utils.ts    # Packet processing helpers
│   ├── hooks/             # usePolling, useDebounce, useThemeColors
│   └── stores/useStore.ts # Zustand store (stats, packets, logs, UI)
└── types/api.ts           # TypeScript interfaces for API responses
```

### Key Patterns

**API Client** (`src/lib/api.ts`): All backend communication through typed functions. Base URL from `NEXT_PUBLIC_API_URL` env var (empty string = same-origin for static deployment).

**Client-Side Computation**: Some stats computed client-side from raw packets:
- `getBucketedStats()` - Time-bucketed packet counts for charts
- `getUtilizationStats()` - Airtime utilization from packet data
- `getFilteredPackets()` - Client-side filtering (backend endpoint has compatibility issues)

**Global State** (`src/lib/stores/useStore.ts`): Zustand store with granular selectors:
```typescript
// Use specific selectors to prevent unnecessary re-renders
const stats = useStats();           // Good
const { stats } = useStore();       // Avoid
```

**Polling**: Use `usePolling` hook from `src/lib/hooks/` for live data updates.

### Backend API

The frontend connects to pyMC_Repeater's CherryPy API (port 8000):

**GET endpoints:**
- `/api/stats` - System statistics, neighbors, config
- `/api/recent_packets?limit=N` - Recent packet history
- `/api/packet_by_hash?packet_hash=X` - Single packet lookup
- `/api/logs` - Recent log entries
- `/api/hardware_stats` - CPU, memory, disk, temperature
- `/api/packet_type_graph_data?hours=N` - Packet type chart data
- `/api/metrics_graph_data?hours=N` - Metrics chart data
- `/api/noise_floor_chart_data?hours=N` - Noise floor history

**POST endpoints:**
- `/api/send_advert` - Trigger advert broadcast
- `/api/set_mode` - Set forward/monitor mode `{mode: "forward"|"monitor"}`
- `/api/set_duty_cycle` - Enable/disable duty cycle `{enabled: bool}`
- `/api/update_radio_config` - Update radio settings (patched by manage.sh)

## manage.sh Installer

The main installer script provides a TUI (whiptail/dialog) for:
- Fresh install from pyMC_Repeater git branch (dev or main)
- Upgrade existing installation
- Radio settings configuration (frequency, power, bandwidth, SF)
- GPIO configuration
- Service management (start/stop/restart/logs)
- Uninstall

### Key Functions in manage.sh

- `do_install()` - Fresh installation flow
- `do_upgrade()` - Upgrade existing installation
- `configure_radio_terminal()` - Radio preset selection
- `create_backend_service()` - Generate systemd service file
- `install_static_frontend()` - Copy built Next.js files to pyMC_Repeater
- `patch_nextjs_static_serving()` - Patch pyMC_Repeater's http_server.py for Next.js routing
- `patch_api_endpoints()` - Add `/api/update_radio_config` endpoint

### Upstream Patches

manage.sh applies patches to pyMC_Repeater during install:

1. **patch_nextjs_static_serving** - Modifies `http_server.py` to serve Next.js static export (route-specific index.html files, `/_next` assets)
2. **patch_api_endpoints** - Adds `/api/update_radio_config` POST endpoint for web-based radio configuration

These should eventually be merged upstream to pyMC_Repeater.

### Important: DEBUG Log Level Fix

The systemd service uses `--log-level DEBUG` which is **required** to fix a timing bug in pymc_core's interrupt initialization. Without it, the asyncio event loop isn't ready when interrupt callbacks register, causing RX to silently fail.

## Configuration

**Frontend API URL**: For development, set in `frontend/.env.local`:
```env
NEXT_PUBLIC_API_URL=http://192.168.1.100:8000  # Remote repeater
```
For production (static export served by backend), leave empty or omit.

**Path alias**: Use `@/` to import from `src/`:
```typescript
import { useStats } from '@/lib/stores/useStore';
import type { Packet } from '@/types/api';
```

**Radio config**: `/etc/pymc_repeater/config.yaml` on target device.

## Type Definitions

Packet and stats types in `src/types/api.ts`. Notable constants:
- `PAYLOAD_TYPES` - Maps packet type numbers to names (REQ, RESPONSE, TXT_MSG, ACK, ADVERT, etc.)
- `ROUTE_TYPES` - Maps route types (UNKNOWN, DIRECT, FLOOD, TRANSPORT, T_FLOOD, T_DIRECT)

## Docker Services (Optional)

For local development or optional monitoring stack:

- `backend` (8000) - pyMC_Repeater API
- `frontend` (3000) - Next.js dev server
- `prometheus` (9090) - Metrics collection
- `grafana` (3002) - Visualization (admin/admin)

```bash
docker-compose up -d prometheus grafana  # Monitoring only
```

## Common Tasks

**Build and test static export locally:**
```bash
cd frontend
npm run build
npx serve out  # Serve at localhost:3000
```

**Deploy to remote Pi:**
```bash
# On Pi:
sudo ./manage.sh upgrade
```

**Check service status:**
```bash
sudo systemctl status pymc-repeater
sudo journalctl -u pymc-repeater -f  # Live logs
```
