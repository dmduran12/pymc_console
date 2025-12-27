---
name: meshcore
description: MeshCore protocol reference for repeater/room server dashboard development. Use when working with packet structure, payload types, routing, path analysis, neighbor detection, topology computation, or pyMC_Repeater API integration.
---

# MeshCore Protocol Reference

MeshCore is a hybrid routing mesh protocol for LoRa radios. This skill covers protocol internals relevant to pymc_console dashboard development.

## Packet Header (1 byte)

| Bits | Mask | Field | Values |
|------|------|-------|--------|
| 0-1 | `0x03` | Route Type | 0=T_FLOOD, 1=FLOOD, 2=DIRECT, 3=T_DIRECT |
| 2-5 | `0x3C` | Payload Type | See below |
| 6-7 | `0xC0` | Payload Version | 0=v1 (1-byte hash, 2-byte MAC) |

## Payload Types

| Value | Name | Description |
|-------|------|-------------|
| `0x00` | REQ | Request (dest/src hashes + MAC) |
| `0x01` | RESPONSE | Response to REQ or ANON_REQ |
| `0x02` | TXT_MSG | Plain text message |
| `0x03` | ACK | Acknowledgment |
| `0x04` | ADVERT | Node advertisement (used for neighbor detection) |
| `0x05` | GRP_TXT | Group text message |
| `0x06` | GRP_DATA | Group datagram |
| `0x07` | ANON_REQ | Anonymous request (room server login) |
| `0x08` | PATH | Returned path (used for topology building) |
| `0x09` | TRACE | Trace path with SNR per hop |
| `0x0A` | MULTIPART | Multi-part packet sequence |
| `0x0B` | CONTROL | Control packet (DISCOVER_REQ/RESP) |
| `0x0F` | RAW_CUSTOM | Custom raw bytes |

## Route Types

| Value | Name | Description |
|-------|------|-------------|
| `0x00` | T_FLOOD | Flood + transport codes |
| `0x01` | FLOOD | Broadcast, path built by forwarders |
| `0x02` | DIRECT | Unicast with pre-computed path |
| `0x03` | T_DIRECT | Direct + transport codes |

**CRITICAL**: Route type = routing METHOD, not hop count. DIRECT packets can be multi-hop.

## Node Hash

First byte of Ed25519 public key. Used in paths as 2-char hex prefix (e.g., `"FA"`, `"19"`).

## Appdata Flags (ADVERT payload)

| Value | Meaning | Dashboard Use |
|-------|---------|---------------|
| `0x01` | Chat node (companion) | Filter from topology |
| `0x02` | Repeater | Include in topology |
| `0x03` | Room server | Include in topology |
| `0x04` | Sensor | Include in topology |
| `0x10` | Has lat/long | Map placement |
| `0x80` | Has name | Display name |

## Key Concepts for Dashboard Development

**Neighbor Detection**: A node is a "zero-hop neighbor" when we receive ADVERTs where they were the last hop in the path. This indicates direct RF contact.

**Path Analysis**: Packets contain a `path` array of 2-char hex prefixes. Example: `["FA", "79", "24", "19"]` = 4 hops, FA→79→24→19.

**Prefix Disambiguation**: Multiple nodes may share a prefix. Resolve using:
- Position frequency (where prefix typically appears in paths)
- Co-occurrence (which prefixes appear adjacent)
- Geographic proximity (distance from anchor nodes)
- Recency (exponential decay, e^(-hours/12))

**Topology Edges**: Build edges from PATH packets. Track:
- `forwardCount`/`reverseCount` for symmetry
- `floodCount`/`directCount` for route type
- `validations` for confidence

**Clients don't repeat**: Only repeaters/room servers forward packets.

## Reference Files

- [references/packet-structure.md](references/packet-structure.md) - Full packet field breakdown with parsing examples
- [references/payloads.md](references/payloads.md) - Detailed payload formats (ADVERT, PATH, REQ, etc.)
- [references/repeater-cli.md](references/repeater-cli.md) - MeshCore firmware CLI commands (not pyMC_Repeater)
- [references/faq.md](references/faq.md) - Protocol FAQ for dashboard development

## pyMC_Repeater API Reference

The dashboard connects to pyMC_Repeater's CherryPy API (port 8000).

### System
- `GET /api/stats` - Node stats, neighbors, config, version
- `GET /api/logs` - Recent log entries
- `GET /api/hardware_stats` - CPU, memory, disk, temperatures

### Packets
- `GET /api/recent_packets?limit=100` - Recent packet history
- `GET /api/filtered_packets?type=4&route=1&start_timestamp=X&end_timestamp=Y&limit=1000`
- `GET /api/packet_by_hash?packet_hash=abc123` - Single packet lookup
- `GET /api/packet_stats?hours=24` - Packet statistics
- `GET /api/packet_type_stats?hours=24` - Breakdown by type
- `GET /api/route_stats?hours=24` - Breakdown by route

### Charts & Time Series
- `GET /api/packet_type_graph_data?hours=24` - Packet types over time
- `GET /api/metrics_graph_data?hours=24` - Metrics over time
- `GET /api/noise_floor_history?hours=24` - Noise floor history
- `GET /api/noise_floor_stats?hours=24` - Noise floor statistics

### Control
- `POST /api/send_advert` - Trigger advert broadcast
- `POST /api/set_mode` - `{"mode": "forward"|"monitor"}`
- `POST /api/set_duty_cycle` - `{"enabled": true|false}`
- `POST /api/global_flood_policy` - Set flood allow policy

### Identity Management
- `GET /api/identities` - List all identities
- `GET /api/identity?name=X` - Get specific identity
- `POST /api/create_identity` - Create new identity
- `PUT /api/update_identity` - Update existing identity
- `DELETE /api/delete_identity?name=X` - Delete identity

### ACL (Access Control)
- `GET /api/acl_info` - ACL config and stats for all identities
- `GET /api/acl_clients?identity_hash=0x42` - List authenticated clients
- `POST /api/acl_remove_client` - Remove client from ACL
- `GET /api/acl_stats` - Overall ACL statistics

### Room Server
- `GET /api/room_messages?room_name=X&limit=50` - Get messages
- `POST /api/room_post_message` - Post message to room
- `GET /api/room_stats` - Room statistics
- `GET /api/room_clients?room_name=X` - Clients synced to room
- `DELETE /api/room_message?room_name=X&message_id=123` - Delete message

### CAD Calibration
- `POST /api/cad_calibration_start` - `{"samples": 8, "delay": 100}`
- `POST /api/cad_calibration_stop` - Stop calibration
- `POST /api/save_cad_settings` - `{"peak": 127, "min_val": 64}`
- `GET /api/cad_calibration_stream` - SSE stream for calibration progress

### Channel Health & LBT
- `GET /api/channel_health` - Composite health score with LBT, noise, link quality
- `GET /api/lbt_stats?hours=24` - Listen-Before-Talk statistics
- `GET /api/link_quality` - Per-neighbor link quality scores

### Transport Keys
- `GET /api/transport_keys` - List transport keys
- `POST /api/transport_keys` - Create transport key
- `PUT /api/transport_key` - Update transport key
- `DELETE /api/transport_key?id=X` - Delete transport key

### Adverts
- `GET /api/adverts_by_contact_type?contact_type=repeater` - Filter adverts by type
- `POST /api/send_room_server_advert` - `{"name": "..."}` - Send room server advert

### Packet Fields from API
```typescript
interface Packet {
  id: number;           // Database ID
  timestamp: number;    // Unix timestamp
  packet_hash: string;  // Unique hash
  type: number;         // Payload type (0x00-0x0F)
  route: number;        // Route type (0x00-0x03)
  rssi: number;         // Signal strength (dBm)
  snr: number;          // Signal-to-noise ratio
  length: number;       // Total packet length
  transmitted: boolean; // TX vs RX
  drop_reason: string | null;
  is_duplicate: boolean;
  src_hash?: string;    // Source node prefix
  dst_hash?: string;    // Destination node prefix
  original_path?: string[];  // Path as received
  forwarded_path?: string[]; // Path after forwarding
  lbt_attempts?: number;     // LBT retry count
  lbt_channel_busy?: boolean; // CAD max attempts exceeded
}
```

## Hardware Integration (pyMC_Repeater + pyMC_core)

### Architecture Stack
```
┌─────────────────────────────────────────────────────────┐
│  pyMC_Repeater (Application Layer)                      │
│  - RepeaterDaemon: Main entry point                     │
│  - RepeaterHandler: Packet processing, forwarding logic │
│  - PacketRouter: Routes packets to protocol helpers     │
│  - HTTP API: CherryPy server on port 8000               │
├─────────────────────────────────────────────────────────┤
│  pyMC_core (Protocol Layer)                             │
│  - Dispatcher: Routes packets to handlers by type       │
│  - Packet: Parses/serializes MeshCore packets           │
│  - LocalIdentity: Ed25519 keypair management            │
│  - Protocol handlers: ADVERT, PATH, TEXT, ACK, etc.     │
├─────────────────────────────────────────────────────────┤
│  pyMC_core.hardware (Hardware Abstraction)              │
│  - SX1262Radio: LoRa radio driver wrapper               │
│  - LoRaRF/SX126x: Low-level SX1262 register access      │
│  - GPIOPinManager: Raspberry Pi GPIO management         │
├─────────────────────────────────────────────────────────┤
│  Hardware (Physical Layer)                              │
│  - SX1262 LoRa transceiver via SPI                      │
│  - GPIO pins: RESET, BUSY, IRQ, TXEN, RXEN              │
└─────────────────────────────────────────────────────────┘
```

### Radio Initialization Flow
1. `RepeaterDaemon.__init__()` loads config from `/etc/pymc_repeater/config.yaml`
2. `get_radio_for_board(config)` creates `SX1262Radio` instance
3. `SX1262Radio.begin()` initializes hardware:
   - Resets radio via GPIO
   - Configures SPI bus (bus_id, cs_id)
   - Sets frequency, SF, BW, CR, TX power, sync word
   - Configures CAD thresholds for Listen-Before-Talk
   - Sets up IRQ pin for RX/TX interrupts
4. `Dispatcher(radio)` wraps radio with packet routing
5. `radio.set_rx_callback()` enables continuous RX mode

### Packet RX Flow
```
SX1262 IRQ pin → GPIO interrupt → _irq_trampoline()
  → event_loop.call_soon_threadsafe(_handle_interrupt)
  → _rx_done_event.set()
  → _rx_irq_background_task() reads packet
  → rx_callback(packet_bytes, metadata)
  → Dispatcher._on_packet_received()
  → PacketRouter routes to appropriate helper
  → RepeaterHandler.process_packet() decides forward/drop
```

### Packet TX Flow
```
RepeaterHandler.schedule_retransmit(packet, delay)
  → asyncio.sleep(delay)  # TX delay based on route type
  → Dispatcher.send_packet()
  → perform_cad() # Listen-Before-Talk check
  → If channel busy: backoff and retry (up to 8 attempts)
  → radio.transmit(packet_bytes)
  → Wait for TX_DONE IRQ
  → Return to RX mode
```

### SPI Configuration (config.yaml)
```yaml
sx1262:
  bus_id: 0          # SPI bus (0 or 1)
  cs_id: 0           # Chip select (0 or 1)
  cs_pin: 21         # Manual CS pin (Waveshare HAT)
  reset_pin: 18      # Radio reset GPIO
  busy_pin: 20       # Radio busy GPIO
  irq_pin: 16        # Interrupt GPIO
  txen_pin: 6        # TX enable GPIO
  rxen_pin: -1       # RX enable (-1 if not used)
  use_dio3_tcxo: false
```

### Radio Configuration (config.yaml)
```yaml
radio:
  frequency: 910525000   # Hz (910.525 MHz)
  tx_power: 22           # dBm
  spreading_factor: 7    # SF7-SF12
  bandwidth: 62500       # Hz (62.5 kHz)
  coding_rate: 5         # CR 4/5
  preamble_length: 12
  sync_word: 0x3444      # MeshCore public network
  cad:
    peak_threshold: 23   # CAD detection threshold
    min_threshold: 11    # CAD minimum threshold
```

### Key Classes
- **SX1262Radio** (`pymc_core.hardware.sx1262_wrapper`): Async LoRa driver
- **Dispatcher** (`pymc_core.node.dispatcher`): Packet routing + TX/RX
- **RepeaterHandler** (`repeater.engine`): Forwarding logic, duty cycle
- **PacketRouter** (`repeater.packet_router`): Routes to protocol helpers
- **StorageCollector** (`repeater.data_acquisition`): SQLite packet logging

## Airtime Calculation (Regional Duty Cycle)

**Note**: Only relevant for regions with duty cycle regulations (EU 868MHz). USA/Canada 915MHz ISM band has no duty cycle limit. Load this section only when working on duty cycle features or EU compliance.

```
Symbol time: Tsym = 2^SF / BW
Preamble time: Tpreamble = (npreamble + 4.25) × Tsym
Payload symbols: ceil((8×PL - 4×SF + 28 + 16) / (4×SF)) × CR
Total airtime: Tpacket = Tpreamble + Tsym × payload_symbols
```

Where: SF=spreading factor, BW=bandwidth (Hz), PL=payload bytes, CR=coding rate (5-8)

**pyMC_Repeater implementation**: See `repeater.airtime.AirtimeManager` and `pymc_core.protocol.packet_utils.PacketTimingUtils.estimate_airtime_ms()`
