# MeshCore Protocol FAQ

Focused answers for dashboard/repeater development.

## Routing & Paths

### How does path discovery work?
1. First message floods to destination
2. Destination sends delivery report with path (flood routed back)
3. Future messages use direct routing via learned path
4. If path breaks (3 retries fail), reverts to flood on last retry

### Do channels always flood?
Yes. Group channels have no defined path, so they must flood. Repeaters can limit with `set flood.max {hops}`.

### What's the hop limit?
Internal max is 64 hops. Practical limits depend on timing and environment.

### Do clients repeat?
**No.** Only repeaters and room servers (with `set repeat on`) forward packets. This is core to MeshCore's design - prevents broadcast storms.

## Adverts

### What is an "advert"?
Broadcasting node identity: name, location (if set), public key, and signature. Two modes:
- **Zero-hop**: Direct broadcast to RF neighbors only
- **Flood**: Rebroadcast by all repeaters that hear it

### How often do repeaters advert?
Default: every 3 hours (180 min). Configurable via `set advert.interval {minutes}`. Likely moving to 12h default.

### How to detect neighbors?
A node is a "zero-hop neighbor" when you receive ADVERTs where they were the **last hop** in the path. This indicates their TX reached your RX directly.

## Packet Structure

### What's in the header byte?
- Bits 0-1: Route type (FLOOD=1, DIRECT=2, etc.)
- Bits 2-5: Payload type (ADVERT=4, PATH=8, etc.)
- Bits 6-7: Payload version (currently 0)

### What's a node hash?
First byte of the node's Ed25519 public key. Used as 2-char hex prefix in paths (e.g., `"FA"`, `"19"`).

### Why might multiple nodes share a prefix?
With only 256 possible prefixes and growing networks, collisions happen. Disambiguation requires analyzing position patterns, co-occurrence, geography, and recency.

## Room Servers

### How do room servers differ from repeaters?
- Store message history (pushed to clients)
- Support guest authentication
- Can optionally repeat (`set repeat on`), but not recommended
- Clients can "roam" - come back later and retrieve missed messages

### What's the login flow?
Client sends ANON_REQ with timestamp, sync timestamp, and password. Room server validates and adds to ACL.

## Radio Parameters

### What are BW, SF, CR?
- **BW (Bandwidth)**: Frequency width (62.5, 125, 250, 500 kHz). Wider = faster, narrower = better noise rejection
- **SF (Spreading Factor)**: 7-12. Higher = longer range but slower. Each step halves speed
- **CR (Coding Rate)**: 5-8. Higher = more error correction. Use 5 for solid links, 7-8 for intermittent

### Current recommended settings?
USA/Canada: 910.525MHz, SF7, BW62.5, CR5 (narrowband, lower noise floor)

## pymc_console Dashboard Development

### How to detect zero-hop neighbors?
In the `/api/stats` response, check `neighbors[hash].zero_hop`. Alternatively, analyze packet paths - if a node's hash is the **last element** in `original_path`, they're a direct RF contact.

### What does `packet_origin` mean?
- `rx` - Received from radio (not originated by us)
- `tx_local` - We originated this packet (our advert, trace response, etc.)
- `tx_forward` - We forwarded someone else's packet

### How are paths stored in the API?
Arrays of 2-char uppercase hex strings: `["FA", "79", "24"]`. The first element is the packet origin, last is the most recent forwarder.

### Why do some packets have both `original_path` and `forwarded_path`?
- `original_path`: Path as received (before we touched it)
- `forwarded_path`: Path after we appended our hash (only if `transmitted: true`)

## Related Projects

- **pyMC_core**: Python port of MeshCore for Raspberry Pi (SPI to LoRa) - https://github.com/rightup/pyMC_core
- **pyMC_Repeater**: Python repeater using pyMC_core - https://github.com/rightup/pyMC_Repeater
- **meshcore-decoder**: TypeScript packet decoder with WASM crypto - https://github.com/michaelhart/meshcore-decoder
- **meshcore.js**: JavaScript library for companion radio - https://github.com/liamcottle/meshcore.js
