# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

pymc_console is a **dashboard that plugs into** [pyMC_Repeater](https://github.com/rightup/pyMC_Repeater), a LoRa mesh network repeater built on [pymc_core](https://github.com/rightup/pyMC_core). 

**Philosophy**: We install pyMC_Repeater exactly as upstream intends, then layer our dashboard on top. Our manage.sh honors upstream's installation flow and paths.

- **Vite + React Dashboard** - Real-time monitoring of packets, neighbors, stats, and radio config
- **manage.sh Installer** - TUI that installs upstream pyMC_Repeater + our dashboard overlay
- **True SPA** - Single index.html served by CherryPy; React Router handles all client-side routing

## Git Workflow Rules

**IMPORTANT for Warp:**
- **NEVER commit or push changes unless explicitly asked by the user**
- Make code changes and let the user review before committing
- When asked to commit, include `Co-Authored-By: Warp <agent@warp.dev>` in commit messages

## Tech Stack

- **Frontend**: Vite 6, React 18, React Router 6, TypeScript, Tailwind CSS 4
- **State Management**: Zustand
- **Charts**: Recharts
- **Maps**: Leaflet 1.9 / react-leaflet 4.2 (React 18 compatible)
- **Icons**: lucide-react
- **Installer**: Bash with whiptail/dialog TUI

## Repository Structure

```
pymc_console/
├── .github/workflows/     # GitHub Actions CI/CD
│   └── build-ui.yml       # Automated build & release workflow
├── frontend/              # Vite + React SPA dashboard
│   ├── src/               # Source code
│   ├── out/               # Build output (gitignored)
│   └── dist/              # Release artifacts (gitignored)
├── manage.sh              # Main installer/manager script (TUI)
├── RELEASE.md             # Release process documentation
├── INSTALL.md             # Standalone UI installation guide
├── README.md              # User documentation
├── WARP.md                # Developer documentation
└── LICENSE
```

## Development Commands

```bash
# Frontend development (from frontend/)
cd frontend
npm install           # Install dependencies
npm run dev           # Start Vite dev server at http://localhost:5173
npm run build         # Production build → frontend/out/
npm run build:static  # Build + package for release → frontend/dist/
npm run preview       # Preview production build locally
npm run lint          # Run ESLint

# Installer (run as root on target Pi)
sudo ./manage.sh            # TUI menu
sudo ./manage.sh install    # Non-interactive install
sudo ./manage.sh upgrade    # Upgrade existing installation
```

## Architecture

### Deployment Model

The dashboard is a **true Single Page Application (SPA)** built with Vite. A single `index.html` is served for all routes, and React Router handles client-side navigation.

**Why SPA?** Upstream CherryPy's `default()` method already returns `index.html` for all unknown routes - this is exactly what an SPA needs. No backend patches required for routing.

**Release-based deployment** (production):
1. GitHub Actions builds on push to main/dev
2. Version tags (e.g., `v0.2.0`) trigger GitHub Releases with `.tar.gz` and `.zip` archives
3. `manage.sh install/upgrade` downloads from GitHub Releases
4. pyMC_Repeater's CherryPy server serves the dashboard at port 8000

**Local development**:
1. `npm run dev` starts Vite dev server with HMR at http://localhost:5173
2. `npm run build` generates static files in `frontend/out/`
3. `npm run preview` serves the production build locally

### Installation Flow (Mirrors Upstream)

The installer follows the same flow as upstream's `manage.sh`:
1. User clones `pymc_console` to their preferred location (e.g., `~/pymc_console`)
2. User runs `sudo ./manage.sh install`
3. Script clones `pyMC_Repeater` as a sibling directory (e.g., `~/pyMC_Repeater`)
4. Patches are applied to the clone
5. Files are copied from clone to `/opt/pymc_repeater`
6. Python packages installed from clone directory
7. Dashboard installed to `/opt/pymc_console/web/html/` (separate from upstream Vue.js)
8. `web.web_path` configured in config.yaml to point to our dashboard

This mirrors upstream exactly, making patches easy to submit as PRs. Upstream's Vue.js dashboard remains intact at `/opt/pymc_repeater/repeater/web/html/` as a backup.

**Why no static file serving patch?** Upstream's `default()` method returns `index.html` for all unknown routes. Our SPA works natively with this behavior - React Router handles `/packets`, `/logs`, etc. client-side.

### Directory Structure

**Development/Clone directories (user's home):**
- `~/pymc_console/` - This repo (cloned by user)
- `~/pyMC_Repeater/` - Upstream repo (cloned by manage.sh as sibling)

**Installation directories (on target device):**
- `/opt/pymc_repeater/` - pyMC_Repeater installation (matches upstream)
- `/opt/pymc_repeater/repeater/web/html/` - Upstream Vue.js dashboard (preserved)
- `/opt/pymc_console/` - Our files (radio presets, dashboard, etc.)
- `/opt/pymc_console/web/html/` - Our React SPA dashboard
- `/etc/pymc_repeater/config.yaml` - Radio and repeater configuration
  - `web.web_path` points to our dashboard location
- `/var/log/pymc_repeater/` - Log files
- Systemd service: `pymc-repeater.service` (upstream's file)
- Python packages installed system-wide (via `pip --break-system-packages --ignore-installed`)

### Frontend Structure (`frontend/src/`)

```
src/
├── main.tsx               # React entry point (BrowserRouter setup)
├── App.tsx                # Routes configuration + RootLayout
├── index.css              # Global styles (Tailwind)
├── pages/                 # Page components (one per route)
│   ├── Dashboard.tsx      # / - Home dashboard
│   ├── Packets.tsx        # /packets - Packet history & filtering
│   ├── Neighbors.tsx      # /neighbors - Neighbor map & list
│   ├── Statistics.tsx     # /statistics - Charts & metrics
│   ├── System.tsx         # /system - Hardware stats
│   ├── Logs.tsx           # /logs - System logs
│   └── Settings.tsx       # /settings - Radio configuration
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
│   ├── stores/useStore.ts # Zustand store (stats, packets, logs, UI)
│   └── theme/             # Theme system (ThemeContext, config, hooks)
└── types/api.ts           # TypeScript interfaces for API responses
```

### Key Patterns

**API Client** (`src/lib/api.ts`): All backend communication through typed functions. Base URL from `VITE_API_URL` env var (empty string = same-origin for static deployment).

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

**Theme System** (`src/lib/theme/`): Centralized theme management via React Context:
- `ThemeContext.tsx` - Single source of truth for color scheme, background image, brightness
- `theme-config.ts` - Theme definitions (color schemes, background images, presets)
- `use-theme.ts` - Consumer hook with typed API
- Color schemes map to CSS `[data-theme="..."]` selectors in `index.css`
- Background images and color schemes are decoupled (can be mixed independently)
- localStorage persistence with automatic migration from legacy keys

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

- `do_install()` - Clones pyMC_Repeater to sibling dir, applies patches, copies to `/opt`, installs pip packages, overlays dashboard
- `do_upgrade()` - Updates clone, re-applies patches, syncs to `/opt`, reinstalls packages
- `install_backend_service()` - Copies upstream's service file from clone
- `install_static_frontend()` - Downloads dashboard from GitHub Releases to `/opt/pymc_console/web/html/` and configures `web.web_path`
- `configure_radio_terminal()` - Radio preset selection
- `patch_api_endpoints()` - Applies radio config API patch to target directory
- `patch_logging_section()` - Ensures logging config section exists
- `patch_log_level_api()` - Adds log level toggle API endpoint

### Upstream Patches (PR Candidates)

These patches are applied during install and should be submitted as PRs to pyMC_Repeater:

1. **patch_api_endpoints** - Adds `/api/update_radio_config` POST endpoint for web-based radio configuration
2. **patch_logging_section** - Ensures `config['logging']` exists before setting level from `--log-level` arg
3. **patch_log_level_api** - Adds `/api/set_log_level` POST endpoint for web-based log level toggle

**Removed patches (v0.4.0):** `patch_static_file_serving` was removed during the SPA migration. Upstream's `default()` method already returns `index.html` for unknown routes, which is exactly what a true SPA needs.

### Important: DEBUG Log Level Workaround

There's a timing bug in pymc_core where the asyncio event loop isn't ready when GPIO interrupt callbacks register. This particularly affects faster hardware (Pi 5). The DEBUG flag is currently **disabled for testing** - if RX doesn't work without DEBUG, re-enable it in `install_backend_service()`. TODO: File upstream issue at github.com/rightup/pyMC_core.

### Important: System Python (No Virtualenv)

The installer uses system Python with `--break-system-packages --ignore-installed` to match upstream pyMC_Repeater exactly.

## Configuration

**Frontend API URL**: For development, set in `frontend/.env.local`:
```env
VITE_API_URL=http://192.168.1.100:8000  # Remote repeater
```
For production (SPA served by backend), leave empty or omit.

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

## Common Tasks

**Development workflow:**
```bash
cd frontend
npm install
npm run dev  # Develop at http://localhost:5173 (Vite HMR)
```

**Build and test locally:**
```bash
cd frontend
npm run build
npm run preview  # Preview production build locally
```

**Deploy to Pi (existing installation):**
```bash
# On Pi - downloads latest release from GitHub:
sudo ./manage.sh upgrade
```

**Check service status:**
```bash
sudo systemctl status pymc-repeater
sudo journalctl -u pymc-repeater -f  # Live logs
```

## Release Process

See [RELEASE.md](RELEASE.md) for detailed instructions.

### Quick Release (Recommended)

From the `frontend/` directory:

```bash
cd frontend
npm version patch  # or minor/major - updates package.json
git push origin main
git push origin --tags
```

**Note:** `npm version` only updates `package.json`. You must manually create and push the git tag:

```bash
# After npm version patch shows "v0.4.6":
git add frontend/package.json frontend/package-lock.json
git commit -m "chore: Bump version to v0.4.6"
git tag v0.4.6
git push origin main
git push origin v0.4.6
```

### What Happens Automatically

1. GitHub Actions builds on every push to main/dev
2. Version tags (`v*`) trigger GitHub Releases
3. Release includes `pymc-ui-vX.Y.Z.tar.gz` and `.zip` archives
4. `manage.sh` downloads from releases during install/upgrade

### Versioning

- `patch` (0.4.5 → 0.4.6): Bug fixes
- `minor` (0.4.6 → 0.5.0): New features
- `major` (0.5.0 → 1.0.0): Breaking changes
