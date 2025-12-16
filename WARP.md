# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

pymc_console is a **dashboard that plugs into** [pyMC_Repeater](https://github.com/rightup/pyMC_Repeater), a LoRa mesh network repeater built on [pymc_core](https://github.com/rightup/pyMC_core). 

**Philosophy**: We install pyMC_Repeater exactly as upstream intends, then layer our dashboard on top. Our manage.sh honors upstream's installation flow and paths.

- **Next.js Dashboard** - Real-time monitoring of packets, neighbors, stats, and radio config
- **manage.sh Installer** - TUI that installs upstream pyMC_Repeater + our dashboard overlay
- **Static Export** - Dashboard served directly by pyMC_Repeater's CherryPy backend (no Node.js server needed in production)

## Tech Stack

- **Frontend**: Next.js 16, React 19, TypeScript, Tailwind CSS 4
- **State Management**: Zustand
- **Charts**: Recharts
- **Maps**: Leaflet / react-leaflet
- **Icons**: lucide-react
- **Installer**: Bash with whiptail/dialog TUI

## Repository Structure

```
pymc_console/
├── .github/workflows/     # GitHub Actions CI/CD
│   └── build-ui.yml       # Automated build & release workflow
├── frontend/              # Next.js dashboard (static export)
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
npm run dev           # Start dev server at http://localhost:3000
npm run build         # Production build → frontend/out/
npm run build:static  # Build + package for release → frontend/dist/
npm run lint          # Run ESLint

# Installer (run as root on target Pi)
sudo ./manage.sh            # TUI menu
sudo ./manage.sh install    # Non-interactive install
sudo ./manage.sh upgrade    # Upgrade existing installation
```

## Architecture

### Deployment Model

The dashboard is a **static export** (`output: 'export'` in next.config.ts).

**Release-based deployment** (production):
1. GitHub Actions builds on push to main/dev
2. Version tags (e.g., `v0.2.0`) trigger GitHub Releases with `.tar.gz` and `.zip` archives
3. `manage.sh install/upgrade` downloads from GitHub Releases
4. pyMC_Repeater's CherryPy server serves the dashboard at port 8000

**Local development**:
1. `npm run build` generates static files in `frontend/out/`
2. `npm run build:static` also packages to `frontend/dist/`
3. Test locally with `npx serve out`

### Installation Flow (Mirrors Upstream)

The installer follows the same flow as upstream's `manage.sh`:
1. User clones `pymc_console` to their preferred location (e.g., `~/pymc_console`)
2. User runs `sudo ./manage.sh install`
3. Script clones `pyMC_Repeater` as a sibling directory (e.g., `~/pyMC_Repeater`)
4. Patches are applied to the clone
5. Files are copied from clone to `/opt/pymc_repeater`
6. Python packages installed from clone directory
7. Dashboard overlaid to `/opt/pymc_repeater/repeater/web/html/`

This mirrors upstream exactly, making patches easy to submit as PRs.

### Directory Structure

**Development/Clone directories (user's home):**
- `~/pymc_console/` - This repo (cloned by user)
- `~/pyMC_Repeater/` - Upstream repo (cloned by manage.sh as sibling)

**Installation directories (on target device):**
- `/opt/pymc_repeater/` - pyMC_Repeater installation (matches upstream)
- `/opt/pymc_console/` - Our files (radio presets, etc.)
- `/etc/pymc_repeater/config.yaml` - Radio and repeater configuration
- `/var/log/pymc_repeater/` - Log files
- Systemd service: `pymc-repeater.service` (upstream's file)
- Python packages installed system-wide (via `pip --break-system-packages --ignore-installed`)

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

- `do_install()` - Clones pyMC_Repeater to sibling dir, applies patches, copies to `/opt`, installs pip packages, overlays dashboard
- `do_upgrade()` - Updates clone, re-applies patches, syncs to `/opt`, reinstalls packages
- `install_backend_service()` - Copies upstream's service file from clone
- `install_static_frontend()` - Downloads dashboard from GitHub Releases to pyMC_Repeater's web directory
- `configure_radio_terminal()` - Radio preset selection
- `patch_static_file_serving()` - Applies Nginx-style try_files behavior for static HTML files
- `patch_api_endpoints()` - Applies radio config API patch to target directory

### Upstream Patches (PR Candidates)

These patches are applied during install and should be submitted as PRs to pyMC_Repeater:

1. **patch_static_file_serving** - Adds Nginx-style `try_files` to CherryPy's `default()` method: tries `$uri.html` before falling back to `index.html`. Also adds `/images/` static directory. Upstream already supports `/_next/` via conditional config.
2. **patch_api_endpoints** - Adds `/api/update_radio_config` POST endpoint for web-based radio configuration

### Important: DEBUG Log Level Workaround

There's a timing bug in pymc_core where the asyncio event loop isn't ready when GPIO interrupt callbacks register. This particularly affects faster hardware (Pi 5). The DEBUG flag is currently **disabled for testing** - if RX doesn't work without DEBUG, re-enable it in `install_backend_service()`. TODO: File upstream issue at github.com/rightup/pyMC_core.

### Important: System Python (No Virtualenv)

The installer uses system Python with `--break-system-packages --ignore-installed` to match upstream pyMC_Repeater exactly.

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

## Common Tasks

**Development workflow:**
```bash
cd frontend
npm install
npm run dev  # Develop at http://localhost:3000
```

**Build and test locally:**
```bash
cd frontend
npm run build
npx serve out  # Test static export at localhost:3000
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

**Quick release:**
```bash
cd frontend
npm version patch  # or minor/major
git push origin main
git push origin --tags
```

**What happens automatically:**
1. GitHub Actions builds on every push to main/dev
2. Version tags (`v*`) trigger GitHub Releases
3. Release includes `pymc-ui-vX.Y.Z.tar.gz` and `.zip` archives
4. `manage.sh` downloads from releases during install/upgrade

**Versioning:**
- `patch` (0.1.1 → 0.1.2): Bug fixes
- `minor` (0.1.2 → 0.2.0): New features
- `major` (0.2.0 → 1.0.0): Breaking changes
