# MeshCore Payloads

Detailed payload formats for each MeshCore packet type. For packet header structure, route types, and payload type values, see [packet-structure.md](packet-structure.md).

All 16 and 32-bit integer fields are Little Endian.

## Important Concepts

**Node hash**: First byte of the node's Ed25519 public key.

## Node Advertisement (PAYLOAD_TYPE_ADVERT)

| Field | Size (bytes) | Description |
|-------|--------------|-------------|
| public key | 32 | Ed25519 public key of the node |
| timestamp | 4 | Unix timestamp of advertisement |
| signature | 64 | Ed25519 signature of public key, timestamp, and app data |
| appdata | rest of payload | Optional, see below |

### Appdata Fields

| Field | Size (bytes) | Description |
|-------|--------------|-------------|
| flags | 1 | Specifies which fields are present |
| latitude | 4 (optional) | Decimal latitude × 1000000, integer |
| longitude | 4 (optional) | Decimal longitude × 1000000, integer |
| feature 1 | 2 (optional) | Reserved for future use |
| feature 2 | 2 (optional) | Reserved for future use |
| name | rest of appdata | Name of the node |

### Appdata Flags

| Value | Name | Description |
|-------|------|-------------|
| `0x01` | is chat node | Advert is for a chat node |
| `0x02` | is repeater | Advert is for a repeater |
| `0x03` | is room server | Advert is for a room server |
| `0x04` | is sensor | Advert is for a sensor server |
| `0x10` | has location | Appdata contains lat/long |
| `0x20` | has feature 1 | Reserved |
| `0x40` | has feature 2 | Reserved |
| `0x80` | has name | Appdata contains a node name |

## Acknowledgement (PAYLOAD_TYPE_ACK)

| Field | Size (bytes) | Description |
|-------|--------------|-------------|
| checksum | 4 | CRC checksum of message timestamp, text, and sender pubkey |

Note: For returned path messages, ACK can be sent in the "extra" payload instead of as a separate packet.

## Returned Path, Request, Response, Plain Text Message

Common format for these payload types:

| Field | Size (bytes) | Description |
|-------|--------------|-------------|
| destination hash | 1 | First byte of destination node public key |
| source hash | 1 | First byte of source node public key |
| cipher MAC | 2 | MAC for encrypted data |
| ciphertext | rest of payload | Encrypted message (see subsections) |

### Returned Path (PAYLOAD_TYPE_PATH)

Provides route a packet took from the original author.

| Field | Size (bytes) | Description |
|-------|--------------|-------------|
| path length | 1 | Length of next field |
| path | (varies) | List of node hashes (one byte each) |
| extra type | 1 | Bundled payload type (e.g., ACK or response) |
| extra | rest of data | Bundled payload content |

### Request (PAYLOAD_TYPE_REQ)

| Field | Size (bytes) | Description |
|-------|--------------|-------------|
| timestamp | 4 | Send time (unix timestamp) |
| request type | 1 | See below |
| request data | rest of payload | Depends on request type |

#### Request Types

| Value | Name | Description |
|-------|------|-------------|
| `0x01` | get stats | Get stats of repeater or room server |
| `0x02` | keepalive | (deprecated) |
| `0x03` | get telemetry data | Request sensor data |
| `0x04` | get min,max,avg data | Sensor min/max/average for time span |
| `0x05` | get access list | Get node's approved access list |

#### Get Stats Response Data

May include: battery level (mV), TX queue length, free queue length, last RSSI, packets received/sent, total airtime/uptime, flood/direct packet counts, error flags, last SNR, duplicate counts.

### Response (PAYLOAD_TYPE_RESPONSE)

| Field | Size (bytes) | Description |
|-------|--------------|-------------|
| tag | 4 | Response tag |
| content | rest of payload | Response content |

### Plain Text Message (PAYLOAD_TYPE_TXT_MSG)

| Field | Size (bytes) | Description |
|-------|--------------|-------------|
| timestamp | 4 | Send time (unix timestamp) |
| txt_type + attempt | 1 | Upper 6 bits: txt_type, lower 2 bits: attempt (0..3) |
| message | rest of payload | Message content |

#### txt_type Values

| Value | Description | Message content |
|-------|-------------|-----------------|
| `0x00` | plain text message | The plain text |
| `0x01` | CLI command | The command text |
| `0x02` | signed plain text | 4-byte sender pubkey prefix + plain text |

## Anonymous Request (PAYLOAD_TYPE_ANON_REQ)

| Field | Size (bytes) | Description |
|-------|--------------|-------------|
| destination hash | 1 | First byte of destination node public key |
| public key | 32 | Sender's Ed25519 public key |
| cipher MAC | 2 | MAC for encrypted data |
| ciphertext | rest of payload | Encrypted message |

### Room Server Login

| Field | Size (bytes) | Description |
|-------|--------------|-------------|
| timestamp | 4 | Sender time (unix timestamp) |
| sync timestamp | 4 | "Sync messages SINCE x" timestamp |
| password | rest of message | Password for room |

### Repeater/Sensor Login

| Field | Size (bytes) | Description |
|-------|--------------|-------------|
| timestamp | 4 | Sender time (unix timestamp) |
| password | rest of message | Password for repeater/sensor |

## Group Text Message / Datagram (PAYLOAD_TYPE_GRP_TXT / GRP_DATA)

| Field | Size (bytes) | Description |
|-------|--------------|-------------|
| channel hash | 1 | First byte of SHA256 of channel's shared key |
| cipher MAC | 2 | MAC for encrypted data |
| ciphertext | rest of payload | Encrypted message |

Plaintext format: 4-byte timestamp + flags byte (`0x00` for plain text) + message as `<sender name>: <message body>`.

## Control Data (PAYLOAD_TYPE_CONTROL)

| Field | Size (bytes) | Description |
|-------|--------------|-------------|
| flags | 1 | Upper 4 bits is sub_type |
| data | rest of payload | Typically unencrypted |

### DISCOVER_REQ (sub_type 0x8)

| Field | Size (bytes) | Description |
|-------|--------------|-------------|
| flags | 1 | 0x8 (upper 4 bits), prefix_only (lowest bit) |
| type_filter | 1 | Bit for each ADV_TYPE_* |
| tag | 4 | Randomly generated by sender |
| since | 4 (optional) | Epoch timestamp (0 by default) |

### DISCOVER_RESP (sub_type 0x9)

| Field | Size (bytes) | Description |
|-------|--------------|-------------|
| flags | 1 | 0x9 (upper 4 bits), node_type (lower 4) |
| snr | 1 | Signed, SNR×4 |
| tag | 4 | Reflected back from DISCOVER_REQ |
| pubkey | 8 or 32 | Node's ID (or prefix) |

## Custom Packet (PAYLOAD_TYPE_RAW_CUSTOM)

No defined format - raw bytes with custom encryption.
