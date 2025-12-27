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
- **Build**: SWC (via `@vitejs/plugin-react-swc`) for fast React transforms
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
npm run typecheck     # TypeScript type checking (no emit)
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
│   ├── Contacts.tsx       # /contacts - Neighbor map & list (renamed from Neighbors.tsx)
│   ├── Statistics.tsx     # /statistics - Charts & metrics
│   ├── System.tsx         # /system - Hardware stats
│   ├── Logs.tsx           # /logs - System logs
│   └── Settings.tsx       # /settings - Radio configuration
├── components/
│   ├── charts/            # AirtimeGauge, PacketTypesChart, TrafficStackedChart, NeighborPolarChart
│   ├── controls/          # ControlPanel (mode/duty cycle)
│   ├── layout/            # Sidebar, Header, BackgroundProvider
│   ├── contacts/          # ContactsMap, PathHealthPanel (topology visualization)
│   ├── packets/           # PacketRow, PacketDetailModal, PathMapVisualization
│   ├── shared/            # TimeRangeSelector, BackgroundSelector
│   ├── stats/             # StatsCard
│   ├── ui/                # HashBadge, ConfirmModal, DeepAnalysisModal
│   └── widgets/           # LBT Insights mini-widgets (MiniWidget, WidgetRow)
├── lib/
│   ├── api.ts             # All API client functions (typed fetch wrappers)
│   ├── airtime.ts         # LoRa airtime calculation (Semtech formula)
│   ├── constants.ts       # App constants (time ranges, colors, polling intervals)
│   ├── edge-styling.ts    # Topology edge color/weight functions
│   ├── format.ts          # Formatting utilities
│   ├── geo-utils.ts       # Geographic utilities (Haversine, proximity bands)
│   ├── mesh-topology.ts   # Mesh network analysis (7-phase topology system)
│   ├── meshcore-tx-constants.ts # MeshCore TX delay constants
│   ├── packet-cache.ts    # Deep packet loading (20K limit) with caching
│   ├── packet-utils.ts    # Packet processing helpers
│   ├── path-registry.ts   # Path sequence tracking and canonical path detection
│   ├── path-utils.ts      # Centralized path parsing and iteration utilities
│   ├── prefix-disambiguation.ts # Multi-factor prefix→node disambiguation system
│   ├── sparkline-service.ts # Sparkline computation service
│   ├── spectrum-utils.ts  # Spectrum analysis utilities
│   ├── topology-service.ts # Web Worker orchestration for topology computation
│   ├── hooks/             # usePolling, useDebounce, useThemeColors
│   ├── stores/            # Zustand stores
│   │   ├── useStore.ts    # Main store (stats, packets, logs, UI, topology)
│   │   ├── useTopologyStore.ts # Topology-specific state
│   │   └── useSparklineStore.ts # Sparkline data cache
│   ├── theme/             # Theme system (ThemeContext, config, hooks)
│   └── workers/           # Web Workers (computation off main thread)
│       ├── topology.worker.ts   # Topology computation worker
│       └── sparkline.worker.ts  # Sparkline computation worker
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

### LBT Insights Widget Suite (`components/widgets/`)

Compact dashboard widgets displaying channel health, LBT metrics, and link quality. Located in the top row of the Dashboard, below the hero card.

**Widget Layout:**
- Desktop (≥1280px): 8 columns in single row
- Tablet (768-1279px): 4 columns, 2 rows
- Mobile (<768px): 2 columns, 4 rows

**Widgets (left to right):**
1. **ChannelHealthWidget** - Composite health score (0-100) combining LBT, noise, link quality
2. **LBTRetryWidget** - % of TX requiring CAD backoff retries
3. **ChannelBusyWidget** - Count of channel busy events (max CAD attempts exceeded)
4. **CollisionWidget** - Estimated collision risk from LBT patterns
5. **NoiseFloorWidget** - Current noise floor (dBm) with trend indicator
6. **NetworkScoreWidget** - Average link quality across all neighbors
7. **BestWorstLinkWidget** - Shows best and worst neighbor links
8. **CADTunerWidget** - Auto-tuner toggle (placeholder for future feature)

**Base Component** (`MiniWidget.tsx`):
```typescript
<MiniWidget
  title="LBT Retries"
  icon={<RefreshCw className="mini-widget-icon" />}
  value="2.4"
  unit="%"
  status="good"         // excellent|good|fair|congested|critical
  trend="down"          // up (worse)|down (better)|stable
  subtitle="Avg 45ms backoff"
  isLoading={loading}
  error={error}
/>
```

**CSS Classes** (`index.css`):
- `.mini-widget` - Base card styling
- `.mini-widget-value` + `.excellent|good|fair|congested|critical` - Colored value text
- `.mini-widget-progress` + `.mini-widget-progress-bar` - Health bar visualization
- `.widget-row` - Responsive grid container

**Backend Endpoints** (added to pyMC_Repeater `api_endpoints.py`):
- `GET /api/lbt_stats?hours=24` - LBT retry rate, channel busy events, backoff times
- `GET /api/noise_floor_stats_extended?hours=24` - Noise floor with trend analysis
- `GET /api/link_quality_scores?hours=24` - Per-neighbor quality scores
- `GET /api/channel_health` - Composite health combining all metrics

**Theme System** (`src/lib/theme/`): Centralized theme management via React Context:
- `ThemeContext.tsx` - Single source of truth for color scheme, background image, brightness
- `theme-config.ts` - Theme definitions (color schemes, background images, presets)
- `use-theme.ts` - Consumer hook with typed API
- Color schemes map to CSS `[data-theme="..."]` selectors in `index.css`
- Background images and color schemes are decoupled (can be mixed independently)
- localStorage persistence with automatic migration from legacy keys

**Mesh Topology System** (`src/lib/`): Multi-layered network analysis with intelligent prefix disambiguation. Inspired by [meshcore-bot](https://github.com/agessaman/meshcore-bot)'s path analysis.

**Core Files:**
- `prefix-disambiguation.ts` - Four-factor scoring system for resolving 2-char hex prefixes to nodes
- `mesh-topology.ts` - Edge building, validation, and graph construction
- `path-utils.ts` - Centralized path parsing: `parsePath()`, `iteratePathEdges()`, `extractPrefixFromHash()`
- `packet-cache.ts` - Deep packet loading with 20K limit for comprehensive topology
- `topology-service.ts` - Web Worker orchestration for off-main-thread computation

**Disambiguation Scoring** (4 factors):
- **Position (15%)** - How often a candidate appears at each path position
- **Co-occurrence (15%)** - How often pairs of prefixes appear adjacent in paths
- **Geographic (35%)** - Distance-based scoring using dual-hop anchoring
- **Recency (35%)** - Exponential decay scoring based on when node was last seen

**Recency Scoring** (inspired by meshcore-bot):
- Uses exponential decay: `e^(-hours/12)`
- 1 hour ago: ~92%, 12 hours: ~37%, 24 hours: ~14%, 48 hours: ~2%
- Nodes not seen in 14 days (336 hours) are filtered out entirely
- Local node always gets 1.0 recency score

**Dual-Hop Anchor Correlation:**
- **Previous-Hop Anchor** - Upstream prefixes scored by distance from already-resolved previous hop
- **Next-Hop Anchor** - Upstream prefixes scored by distance from already-resolved downstream node
- A relay node should be within RF range of both its upstream and downstream neighbors

**Special Correlations:**
- **Source-Geographic Correlation** - Position-1 prefixes scored by distance from packet's `src_hash` location
- **Score-Weighted Redistribution** - Appearance counts redistributed proportionally by combined score

**Edge Certainty Logic:**
Edges are marked "certain" when:
- Both endpoints have ≥0.6 confidence, OR
- The destination node has ≥0.9 confidence (even if source is ambiguous), OR
- Destination is the local node (last hop)

**Key Constants:**
- `DEEP_FETCH_LIMIT = 20000` - Packets loaded for topology analysis (~7 days)
- `MIN_EDGE_VALIDATIONS = 5` - Minimum observations for edge certainty
- `MAX_CANDIDATE_AGE_HOURS = 336` - Filter out nodes not seen in 14 days
- `RECENCY_DECAY_HOURS = 12` - Half-life for recency scoring

**Tiered Confidence Thresholds:**
- `VERY_HIGH_CONFIDENCE_THRESHOLD = 0.9` - Single endpoint certainty is sufficient
- `HIGH_CONFIDENCE_THRESHOLD = 0.6` - Both endpoints required for "certain" edge
- `MEDIUM_CONFIDENCE_THRESHOLD = 0.4` - Minimum for edge inclusion in topology

**Geographic Scoring Bands:**
- VERY_CLOSE (<500m) = 1.0
- CLOSE (<2km) = 0.8
- MEDIUM (<5km) = 0.6
- FAR (<10km) = 0.4
- VERY_FAR (<20km) = 0.2

### Neighbor Detection (v0.6.14+)

A "neighbor" (zero-hop, direct RF contact) is detected using the standard letsme.sh / meshcoretomqtt approach:
- A node is a neighbor when we receive ADVERT packets where they were the **last hop**
- This indicates direct RF contact: they transmitted, we received (their TX → our RX)

**Key Interface** (`QuickNeighbor` in `useStore.ts`):
```typescript
interface QuickNeighbor {
  hash: string;           // Full node hash
  prefix: string;         // 2-char prefix
  count: number;          // ADVERT packets received from them (last hop)
  avgRssi: number | null; // Average signal strength
  avgSnr: number | null;  // Average signal quality
  lastSeen: number;       // Most recent ADVERT timestamp
}
```

**Detection Logic** (`detectQuickNeighbors()`):
1. Filter to received ADVERT packets only (type=4, transmitted=false)
2. For each packet, extract the last hop from the path
3. Resolve the 2-char prefix to a known neighbor hash
4. Accumulate count, RSSI, SNR, and lastSeen

**UI Behavior:**
- Neighbors display the "Direct" badge and yellow ring indicator on the map
- Signal strength metrics (RSSI/SNR) only shown for neighbors (direct RF contact)
- Filter toggle on Contacts page to show only neighbors

### Advanced Topology Analysis (7 Phases)

The `mesh-topology.ts` module implements a comprehensive 7-phase analysis system:

**Phase 1: Directional Edge Tracking**
Tracks traffic direction on each edge:
- `forwardCount`, `reverseCount` - Observations in each direction
- `symmetryRatio` - min/max ratio (1.0 = balanced)
- `dominantDirection` - 'forward', 'reverse', or 'balanced'

**Phase 2: Path Sequence Tracking** (`path-registry.ts`)
Builds a registry of all observed paths:
- `ObservedPath` - Unique path with hops, timestamps, observation count
- `PathRegistry` - Collection indexed by endpoints
- `canonicalPaths` - Most-used path per source-destination pair

**Phase 3: Flood vs Direct Detection**
Distinguishes routing types per edge:
- `floodCount`, `directCount` - Observations by route type
- `isDirectPathEdge` - True if >50% direct-routed (ground truth)

**Phase 4: Edge Betweenness Centrality**
Identifies backbone edges using graph theory:
- `edgeBetweenness` - Map of edge key → normalized score (0-1)
- `backboneEdges` - Top edges by betweenness (high traffic flow)
- Replaces naive "top-3-by-count" heuristic

**Phase 5: Mobile Repeater Detection**
Identifies volatile/mobile nodes:
- `pathVolatility` - How often node appears/disappears (0-1)
- `activeWindowRatio` - Presence across time windows
- `isMobile` - True if volatility > 0.3
- UI: "Mobile" badge in node popup, orange styling

**Phase 6: TX Delay Recommendations (MeshCore Slot-Based System)**
Mesh-wide optimization using MeshCore's slot-based timing formula:
`t(txdelay) = trunc(Af × 5 × txdelay)` where increments <0.2s have NO EFFECT.

*Network Role Classification* (observer-independent):
- **Backbone**: ≥4 neighbors + ≥50% symmetric traffic → 0.6s base delay
- **Hub**: ≥4 neighbors → 0.8s base delay (reduces collision cascades)
- **Relay**: ≥30% symmetric + ≥2 neighbors → 0.7s (MeshCore default)
- **Edge**: Low connectivity/asymmetric → 0.4s (aggressive, lower latency)

*Key Fields:*
- `floodDelaySec`, `directDelaySec` - Slot-aligned delays (0.2s resolution)
- `floodSlots`, `directSlots` - Integer slot counts for MeshCore
- `networkRole` - 'edge' | 'relay' | 'hub' | 'backbone'
- `collisionRisk` - Combined traffic/neighbor/path centrality (0-1)
- `observationSymmetry` - Bidirectional traffic indicator (high = less observer bias)
- `dataConfidence` - 'insufficient' | 'low' | 'medium' | 'high'

*MENTOR-Inspired Utilization Balancing:*
When mesh-wide utilization variance >5% and slack >30%:
- High-utilization nodes → +slots (reduce TX rate)
- Low-utilization nodes → -slots (increase TX opportunities)

*Slot Staggering:*
Multiple nodes at same slot count are staggered to prevent simultaneous TX:
- Sort by traffic intensity (highest gets original slot)
- Every 3rd node gets +0.2s, every 3rd+1 gets +0.4s

**NOTE**: Position-based delays were REMOVED due to observer bias. Path position
is local-centric ("first hop" from our view differs from other nodes' perspectives).

**Phase 7: Path Health Indicators**
Health metrics for observed paths:
- `healthScore` - Combined score (0-1): certainty (40%), recency (30%), trend (15%), alternates (15%)
- `weakestLinkKey` - Edge key of lowest confidence link
- `observationTrend` - Positive (increasing use) or negative (declining)
- `alternatePathsCount` - Redundancy measure
- `estimatedLatencyMs` - Based on hop count and route type
- UI: Collapsible `PathHealthPanel` on Contacts page

**Key Interfaces:**
```typescript
// Phase 1 & 3: TopologyEdge
interface TopologyEdge {
  forwardCount, reverseCount, symmetryRatio, dominantDirection,
  floodCount, directCount, isDirectPathEdge
}

// Phase 5: NodeMobility
interface NodeMobility {
  pathVolatility, pathDiversity, isMobile, activeWindowRatio
}

// Phase 6: TxDelayRecommendation
interface TxDelayRecommendation {
  floodDelaySec, directDelaySec,      // Slot-aligned delays (0.2s resolution)
  floodSlots, directSlots,            // Integer slot counts
  networkRole,                        // 'edge' | 'relay' | 'hub' | 'backbone'
  collisionRisk, confidence,          // 0-1 scores
  observationSymmetry, dataConfidence // Observer bias metrics
}

// Phase 7: PathHealth
interface PathHealth {
  healthScore, weakestLinkKey, avgEdgeCertainty,
  observationTrend, alternatePathsCount, estimatedLatencyMs
}
```

### ContactsMap Component

Interactive Leaflet map with topology visualization, animations, and filtering.

**Visual Design:**
- **Local node**: Yellow house icon (`#FBBF24` Amber-400) - indicates "home" node
- **Hub nodes**: Filled indigo circle (`#6366F1`) - high-centrality nodes
- **Standard nodes**: Indigo ring/torus (`#4338CA`) - minimal, elegant
- **Edges**: Dark gray lines (`#3B3F4A`) with thickness scaled by validation count
- **Loop edges**: Parallel double-lines in indigo (`#3730A3`) indicating redundant paths

**Deep Analysis System:**
Button triggers comprehensive topology rebuild:
1. **Fetching** - Loads 20K packets from cache (`forceDeepLoad()`)
2. **Analyzing** - Brief transition state
3. **Building** - Topology computation (Web Worker)
4. **Complete** - Shows checkmark, auto-enables topology view

Modal (`DeepAnalysisModal.tsx`) shows 3-step progress with purple highlights for active step, green checkmarks for completed.

**Animation Systems:**

*Edge Animations (topology toggle):*
- **Trace-in effect** (2s): Lines "draw" from point A to B with staggered delays using `easeInOutCubic`
- **Retract effect** (0.5s): When toggling off, edges "zip" back toward nodes with `easeOutCubic`
- **Weight interpolation**: Smooth thickness transitions when data updates
- `isAnimatingInitial` flag prevents edge "blink" on toggle-on
- Animation state stays in sync with visibility: edges at progress=0 when hidden, 1 when shown

*Node Animations (Direct toggle):*
- **Staggered fade** (0.5s): Non-direct nodes fade in/out with randomized delays
- Per-node delays stored in ref for consistent animation across toggles
- `nodeOpacities` Map tracks per-node opacity during animation

**Filter Toggles:**
- **Topology** (GitBranch icon) - Show/hide topology edges
- **Solo Hubs** (Network icon) - Filter to hub nodes and their connections
- **Solo Direct** (Radio icon) - Filter to zero-hop (direct RF) neighbors
- **Fullscreen** (Maximize2 icon) - Expand map to fullscreen

**Key State Variables:**
```typescript
showTopology: boolean           // Show topology edges
soloDirect: boolean             // Filter to zero-hop neighbors
soloHubs: boolean               // Filter to hub connections
isExiting: boolean              // Edge retraction animation in progress
nodeOpacities: Map<string, number>  // Per-node opacity for Direct toggle animation
edgeAnimProgress: Map<string, number>  // Per-edge trace progress (0=retracted, 1=extended)
edgeAnimProgressRef: ref        // Ref copy for capturing state at animation start
```

**Icon Creation (Leaflet DivIcon):**
```typescript
createLocalIcon()                    // Yellow house SVG via renderToStaticMarkup
createFilledIcon(color, opacity)     // Filled circle for hubs
createRingIcon(color, opacity)       // Ring/torus for standard nodes
```

### Backend API

The frontend connects to pyMC_Repeater's CherryPy API (port 8000):

**Static file routes (CherryPy):**
- `/assets/*` - Static files (JS, CSS, images) served from `html/assets/`
- `/favicon.ico` - Favicon
- `/*` (default) - Returns `index.html` for client-side routing (SPA)

**IMPORTANT:** CherryPy only serves `/assets/` as static files. Any static assets (images, fonts, etc.) MUST be placed in `public/assets/` during development so they end up in `out/assets/` after build. Do NOT use `/images/` or other paths - they won't be served.

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

Packet and stats types in `src/types/api.ts`.

### MeshCore Packet Constants (CRITICAL)

**Source of truth**: These values come from MeshCore's `Packet.h` and MUST match exactly.

**ROUTE_TYPES** - Maps route type integers to names:
```typescript
// From MeshCore Packet.h:
// ROUTE_TYPE_TRANSPORT_FLOOD = 0x00
// ROUTE_TYPE_FLOOD = 0x01
// ROUTE_TYPE_DIRECT = 0x02
// ROUTE_TYPE_TRANSPORT_DIRECT = 0x03
export const ROUTE_TYPES: Record<number, string> = {
  0x00: 'T_FLOOD',   // Transport flood (0)
  0x01: 'FLOOD',     // Flood routing (1)
  0x02: 'DIRECT',    // Direct/unicast (2)
  0x03: 'T_DIRECT',  // Transport direct (3)
};
```

**IMPORTANT: Route type indicates ROUTING METHOD, not hop count!**
- **FLOOD (0, 1)**: Broadcast routing - path is built by forwarders as packet propagates
- **DIRECT (2, 3)**: Unicast routing with pre-computed path - but CAN STILL BE MULTI-HOP!
- A DIRECT-routed packet with `path: ["FA", "79", "24", "19"]` has 4 hops via unicast
- Zero-hop detection must use **path length**, not route type

**PAYLOAD_TYPES** - Maps payload type integers to names:
```typescript
// From MeshCore Packet.h:
export const PAYLOAD_TYPES: Record<number, string> = {
  0x00: 'REQ',         // PAYLOAD_TYPE_REQ - request (dest/src hashes, MAC, enc data)
  0x01: 'RESPONSE',    // PAYLOAD_TYPE_RESPONSE - response to REQ or ANON_REQ
  0x02: 'TXT_MSG',     // PAYLOAD_TYPE_TXT_MSG - plain text message
  0x03: 'ACK',         // PAYLOAD_TYPE_ACK - simple acknowledgment
  0x04: 'ADVERT',      // PAYLOAD_TYPE_ADVERT - node advertising its Identity
  0x05: 'GRP_TXT',     // PAYLOAD_TYPE_GRP_TXT - group text message (unverified)
  0x06: 'GRP_DATA',    // PAYLOAD_TYPE_GRP_DATA - group datagram (unverified)
  0x07: 'ANON_REQ',    // PAYLOAD_TYPE_ANON_REQ - anonymous request
  0x08: 'PATH',        // PAYLOAD_TYPE_PATH - returned path response
  0x09: 'TRACE',       // PAYLOAD_TYPE_TRACE - trace path, collecting SNR per hop
  0x0A: 'MULTIPART',   // PAYLOAD_TYPE_MULTIPART - packet is part of a sequence
  // 0x0B-0x0E reserved
  0x0F: 'RAW_CUSTOM',  // PAYLOAD_TYPE_RAW_CUSTOM - custom raw bytes
};
```

**Helper functions** (use these instead of magic numbers):
```typescript
import { isFloodRoute, isDirectRoute, ROUTE, PAYLOAD } from '@/types/api';

// Route type checking
if (isFloodRoute(packet.route)) { /* flood or transport flood */ }
if (isDirectRoute(packet.route)) { /* direct or transport direct */ }

// Numeric constants for direct comparison
if (packet.route === ROUTE.FLOOD) { ... }
if (packet.type === PAYLOAD.ADVERT) { ... }
```

## Design System (Tailwind CSS 4)

The design system is defined in `src/index.css` using CSS custom properties and Tailwind's `@theme inline` block.

### Color Architecture

**IMPORTANT - Dynamic Class Purging:** Tailwind 4 purges classes not statically referenced in templates. If you return a class name from a function (e.g., `getColor(x) => 'text-orange-400'`), that class will NOT be in the production build unless:
1. It's defined in `@theme inline` block (preferred)
2. It's statically used elsewhere in the codebase
3. It's added to a safelist

**Always use theme colors** for dynamic styling:
```typescript
// ✓ Good - uses theme color defined in @theme inline
return 'text-signal-poor';     // #FF8A5C - orange
return 'text-accent-secondary'; // #F9D26F - yellow

// ✗ Bad - standard Tailwind class, will be purged
return 'text-orange-400';  // Won't exist in production!
```

### Semantic Color Tokens

Defined in `:root` and exposed via `@theme inline`:

**Signal Quality** (for SNR, confidence indicators):
- `--signal-excellent` (#4CFFB5) - SNR ≥ 5
- `--signal-good` (#39D98A) - SNR 0-5  
- `--signal-fair` (#F9D26F) - SNR -5 to 0
- `--signal-poor` (#FF8A5C) - SNR -10 to -5 (orange)
- `--signal-critical` (#FF5C7A) - SNR < -10

**Accents** (for UI elements):
- `--accent-primary` (#B49DFF) - Lavender, charts
- `--accent-secondary` (#F9D26F) - Yellow, highlights
- `--accent-tertiary` (#71F8E5) - Cyan/mint
- `--accent-success` (#39D98A) - Green
- `--accent-danger` (#FF5C7A) - Red

### Theme Variants

Five color schemes via `[data-theme="..."]` CSS selectors:
- Default (lavender/purple accents)
- `amber` - Warm orange/gold
- `grey` - Cool slate/blue
- `black` - High contrast cyan/white
- `flora` - Nature-inspired greens and earth tones

## Packet Path Analysis

MeshCore packets contain a `path` field with 2-character hex prefixes representing the route:

```typescript
// Example path: ["FA", "79", "24", "19"]
// FA → 79 → 24 → 19 (local node)
// Position:  0    1    2    3 (last hop)
```

### Path Resolution (`prefix-disambiguation.ts`)

The disambiguation system uses multi-factor analysis to resolve ambiguous 2-char prefixes (inspired by [meshcore-bot](https://github.com/agessaman/meshcore-bot)):

1. **Evidence Collection** (per-prefix statistics):
   - `positionCounts[0-4]` - How often prefix appears at each position
   - `cooccurrenceCount` - How often prefix appears adjacent to known prefixes  
   - `srcGeoEvidenceScore` - Correlation with packet source locations (position 1)
   - `lastSeenTimestamp` - When the candidate was last heard
   - `recencyScore` - Exponential decay based on age

2. **Age Filtering** (pre-processing):
   - Candidates not seen in 14 days (`MAX_CANDIDATE_AGE_HOURS = 336`) are filtered out
   - Prevents stale/offline nodes from causing false collisions

3. **Four-Factor Scoring**:
   - **Position (15%)**: Normalized count at observed position vs total observations
   - **Co-occurrence (15%)**: Adjacent prefix relationships from historical data
   - **Geographic (35%)**: Distance from anchor points (dual-hop anchoring)
   - **Recency (35%)**: Exponential decay `e^(-hours/12)` favoring recently-seen nodes

4. **Dual-Hop Anchor Correlation**:
   A relay node must be within RF range of both adjacent hops. The system uses:

   **Previous-Hop Anchor** (upstream):
   ```typescript
   // Use already-resolved previous hop as anchor
   // Position N scored by distance from position N-1's location
   prevHopGeoScore = distanceScore(candidate.location, prevHop.location)
   ```

   **Next-Hop Anchor** (downstream):
   ```typescript
   // Use already-resolved next hop as anchor
   // Position N scored by distance from position N+1's location
   nextHopGeoScore = distanceScore(candidate.location, nextHop.location)
   ```

5. **Special Correlations**:

   **Source-Geographic Correlation** (position 1):
   ```typescript
   // Position-1 prefixes scored by distance from packet origin
   srcGeoEvidenceScore += distanceScore(candidate.location, srcLocation)
   ```

   **Score-Weighted Redistribution**:
   ```typescript
   // When multiple candidates share a prefix, raw appearance counts
   // are redistributed proportionally by combined score
   redistributedCount = rawCount * (myScore / totalScoresForPrefix)
   ```

6. **Confidence Thresholds**:
   - ≥0.9 = Very high confidence (used for edge certainty)
   - ≥0.6 = High confidence (certain edge threshold)
   - ≥0.5 = Included in topology (default threshold)
   - <0.5 = Excluded from edges

### Path Visualization (`PathMapVisualization.tsx`)

**Color Coding** (hop badges):
- Green (`text-accent-success`): 100% - exact match (unique prefix)
- Yellow (`text-accent-secondary`): 50-99% - high confidence
- Orange (`text-signal-poor`): 25-49% - medium confidence  
- Red (`text-accent-danger`): 1-24% - low confidence
- Gray (`text-text-muted`): 0% - unknown prefix

### Centralized Path Utilities (`path-utils.ts`)

```typescript
import { parsePath, iteratePathEdges, extractPrefixFromHash } from '@/lib/path-utils';

// Parse raw path to normalized array
const hops = parsePath(packet.path);  // ["FA", "79", "24", "19"]

// Iterate edge pairs (from → to)
for (const { from, to, fromIndex, toIndex } of iteratePathEdges(hops)) {
  // from="FA", to="79", fromIndex=0, toIndex=1
}

// Extract prefix from various hash formats
extractPrefixFromHash("0x19ABCDEF")  // "19"
extractPrefixFromHash("0x19")        // "19"  (local node format)
```

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
