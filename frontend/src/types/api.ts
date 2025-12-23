// API Response Types for pyMC Repeater

export interface RadioConfig {
  frequency: number;
  tx_power: number;
  bandwidth: number;
  spreading_factor: number;
  coding_rate: number;
  preamble_length: number;
}

export interface RepeaterConfig {
  mode: string;
  use_score_for_tx: boolean;
  score_threshold: number;
  send_advert_interval_hours: number;
  latitude: number;
  longitude: number;
}

export interface DutyCycleConfig {
  max_airtime_percent: number;
  enforcement_enabled: boolean;
}

export interface DelaysConfig {
  tx_delay_factor: number;
  direct_tx_delay_factor: number;
}

export interface StatsConfig {
  node_name: string;
  radio: RadioConfig;
  repeater: RepeaterConfig;
  duty_cycle: DutyCycleConfig;
  delays: DelaysConfig;
}

export interface NeighborInfo {
  name?: string;
  node_name?: string;  // API may return either
  last_seen: number;
  first_seen?: number;
  rssi?: number;
  snr?: number;
  advert_count?: number;
  latitude?: number;
  longitude?: number;
  is_repeater?: boolean;
  route_type?: number;
  contact_type?: string;
  zero_hop?: boolean;  // True if advert was received directly (not relayed)
}

export interface Stats {
  // Node identification
  node_name: string;
  public_key: string | null;
  local_hash: string;
  
  // Packet counts
  // rx_count: packets received from radio
  // tx_count: packets we originated locally (adverts, trace responses)
  // forwarded_count: received packets that we retransmitted
  // dropped_count: received packets that we did NOT retransmit
  rx_count: number;
  tx_count: number;
  forwarded_count: number;
  dropped_count: number;
  
  // Rate stats
  rx_per_hour: number;
  forwarded_per_hour: number;
  
  // Timing
  uptime_seconds: number;
  
  // Radio
  noise_floor_dbm: number | null;
  
  // Airtime tracking (from AirtimeManager.get_stats())
  airtime_used_ms: number;
  airtime_remaining_ms: number;
  duty_cycle_percent: number;
  current_airtime_ms: number;
  max_airtime_ms: number;
  utilization_percent: number;
  total_airtime_ms: number;
  
  // Cache info
  duplicate_cache_size: number;
  cache_ttl: number;
  
  // Neighbors
  neighbors: Record<string, NeighborInfo>;
  
  // Full config
  config: StatsConfig;
  
  // Version info
  version: string;
  core_version: string;
}

// Duplicate packet entry (compact, stored in SQLite JSON array)
export interface PacketDuplicate {
  timestamp: number;
  rssi?: number;
  snr?: number;
}

export interface Packet {
  // ID may be numeric from DB or undefined for in-memory packets
  id?: number;
  timestamp: number;
  packet_hash: string;
  
  // Payload type - API returns 'type' as int, frontend may use payload_type/payload_type_name
  type?: number;  // From SQLite API
  payload_type?: number;
  payload_type_name?: string;
  
  // Route type - API returns 'route' as int, frontend may use route_type/route_type_name  
  route?: number;  // From SQLite API
  route_type?: number;
  route_type_name?: string;
  
  // Signal info
  rssi: number;
  snr: number;
  
  // Size info
  length?: number;  // From SQLite API
  path_length?: number;
  payload_length?: number;
  
  // Status
  transmitted: boolean;
  drop_reason: string | null;
  is_duplicate: boolean;
  tx_delay_ms?: number;
  
  // Packet origin: 'rx' (received), 'tx_local' (originated here), 'tx_forward' (forwarding)
  packet_origin?: 'rx' | 'tx_local' | 'tx_forward';
  
  // Duplicate tracking (persisted to SQLite, survives restarts)
  duplicates?: PacketDuplicate[];
  
  // Additional fields from API
  src_hash?: string;
  dst_hash?: string;
  path_hash?: string;
  score?: number;
  header?: string;
  payload?: string;
  original_path?: string[];
  forwarded_path?: string[];
  raw_packet?: string;

  // LBT (Listen Before Talk) fields - present on transmitted packets
  lbt_attempts?: number;
  lbt_backoff_delays_ms?: string; // JSON array string, e.g. "[192.0, 314.0]"
  lbt_channel_busy?: boolean | number; // 1/0 or true/false
}

export interface PacketFilters {
  type?: number;
  route?: number;
  start_timestamp?: number;
  end_timestamp?: number;
  limit?: number;
}

export interface LogEntry {
  message: string;
  timestamp: string;
  level: string;
}

export interface NoiseFloorData {
  timestamp: number;
  noise_floor: number;
}

export interface ChartDataPoint {
  timestamp: number;
  value: number;
}

export interface PacketTypeStats {
  [key: string]: number;
}

// Hardware stats - matches pyMC_Repeater's StorageCollector.get_hardware_stats()
export interface HardwareStats {
  cpu: {
    usage_percent: number;
    count: number;
    frequency: number;
    load_avg: {
      '1min': number;
      '5min': number;
      '15min': number;
    };
  };
  memory: {
    total: number;      // bytes
    available: number;  // bytes
    used: number;       // bytes
    usage_percent: number;
  };
  disk: {
    total: number;      // bytes
    used: number;       // bytes
    free: number;       // bytes
    usage_percent: number;
  };
  network: {
    bytes_sent: number;
    bytes_recv: number;
    packets_sent: number;
    packets_recv: number;
  };
  system: {
    uptime: number;     // seconds
    boot_time: number;  // unix timestamp
  };
  temperatures: Record<string, number>;  // e.g. { cpu_thermal: 46.3, nvme_0: 45.85 }
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  count?: number;
}

export interface GraphDataSeries {
  name: string;
  type: string;
  data: [number, number][];
}

export interface GraphData {
  start_time: number;
  end_time: number;
  step: number;
  timestamps: number[];
  series: GraphDataSeries[];
}

// Packet type constants
export const PAYLOAD_TYPES: Record<number, string> = {
  0: 'REQ',
  1: 'RESPONSE',
  2: 'TXT_MSG',
  3: 'ACK',
  4: 'ADVERT',
  5: 'GRP_TXT',
  6: 'GRP_DATA',
  7: 'ANON_REQ',
  8: 'PATH',
  9: 'TRACE',
  10: 'RAW_CUSTOM',
};

export const ROUTE_TYPES: Record<number, string> = {
  0: 'UNKNOWN',
  1: 'DIRECT',
  2: 'FLOOD',
  3: 'TRANSPORT',
  4: 'T_FLOOD',   // Transport flood
  5: 'T_DIRECT',  // Transport direct
};

// ═══════════════════════════════════════════════════════════════════════════
// Identity Management Types (feat/identity branch)
// ═══════════════════════════════════════════════════════════════════════════

export interface RoomServerSettings {
  node_name?: string;
  latitude?: number;
  longitude?: number;
  disable_fwd?: boolean;
  admin_password?: string;
  guest_password?: string;
}

export interface Identity {
  name: string;
  type: 'repeater' | 'room_server';
  hash: string | null;
  address?: string;
  identity_key?: string;
  identity_key_length?: number;
  settings?: RoomServerSettings;
  registered?: boolean;
  runtime?: {
    hash: string;
    address: string;
    type: string;
    registered: boolean;
  };
}

export interface IdentityCreateRequest {
  name: string;
  identity_key?: string;  // Optional - auto-generated if not provided
  type: 'room_server';
  settings?: RoomServerSettings;
}

export interface IdentityUpdateRequest {
  name: string;           // Required - used to find identity
  new_name?: string;      // Optional - rename identity
  identity_key?: string;  // Optional - update key
  settings?: RoomServerSettings;
}

export interface IdentitiesResponse {
  registered: Array<{
    hash: string;
    name: string;
    type: string;
    address: string;
  }>;
  configured: Identity[];
  total_registered: number;
  total_configured: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// ACL (Access Control List) Types
// ═══════════════════════════════════════════════════════════════════════════

export interface ACLInfo {
  name: string;
  type: 'repeater' | 'room_server';
  hash: string;
  max_clients: number;
  authenticated_clients: number;
  has_admin_password: boolean;
  has_guest_password: boolean;
  allow_read_only: boolean;
}

export interface ACLInfoResponse {
  acls: ACLInfo[];
  total_identities: number;
  total_authenticated_clients: number;
}

export interface ACLClient {
  public_key: string;       // Truncated: "abc123...def456"
  public_key_full: string;  // Full hex string
  address: string;
  permissions: 'admin' | 'guest';
  last_activity: number;
  last_login_success: number;
  last_timestamp: number;
  identity_name: string;
  identity_type: string;
  identity_hash: string;
}

export interface ACLClientsResponse {
  clients: ACLClient[];
  count: number;
  filter: {
    identity_hash: string | null;
    identity_name: string | null;
  } | null;
}

export interface ACLStats {
  total_identities: number;
  total_clients: number;
  admin_clients: number;
  guest_clients: number;
  by_identity_type: {
    repeater: { count: number; clients: number };
    room_server: { count: number; clients: number };
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Room Server Types
// ═══════════════════════════════════════════════════════════════════════════

export interface RoomMessage {
  id: number;
  author_pubkey: string;
  author_prefix: string;   // First 8 chars of pubkey
  author_name?: string;    // Looked up from adverts table
  post_timestamp: number;
  sender_timestamp: number;
  message_text: string;
  txt_type: number;
  created_at: number;
}

export interface RoomMessagesResponse {
  room_name: string;
  room_hash: string;
  messages: RoomMessage[];
  count: number;
  total: number;
  limit: number;
  offset: number;
}

export interface RoomPostMessageRequest {
  room_name?: string;   // Either room_name or room_hash required
  room_hash?: string;
  message: string;
  author_pubkey: string;  // hex string, or "server"/"system" for system messages
  txt_type?: number;      // Default 0
}

export interface RoomPostMessageResponse {
  message_id: number | null;
  room_name: string;
  room_hash: string;
  queued_for_distribution: boolean;
  is_server_message: boolean;
  author_filter_note: string;
}

export interface RoomStats {
  room_name: string;
  room_hash: string;
  message_count: number;
  client_count: number;
  synced_clients: number;
  last_message_timestamp?: number;
  oldest_message_timestamp?: number;
}

export interface RoomStatsResponse {
  rooms: RoomStats[];
  total_rooms: number;
  total_messages: number;
  total_clients: number;
}

export interface RoomClient {
  public_key: string;
  public_key_full: string;
  last_sync_timestamp: number;
  messages_synced: number;
}

export interface RoomClientsResponse {
  room_name: string;
  room_hash: string;
  clients: RoomClient[];
  count: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Transport Key Types
// ═══════════════════════════════════════════════════════════════════════════

export interface TransportKey {
  id: number;
  name: string;
  transport_key?: string;  // May be null/empty
  flood_policy: 'allow' | 'deny';
  parent_id?: number;
  last_used: number;       // Unix timestamp
  created_at?: number;
}

export interface TransportKeyCreateRequest {
  name: string;
  flood_policy: 'allow' | 'deny';
  transport_key?: string;  // Optional
  parent_id?: number;
  last_used?: string;      // ISO timestamp string
}

export interface TransportKeyUpdateRequest {
  name?: string;
  flood_policy?: 'allow' | 'deny';
  transport_key?: string;
  parent_id?: number;
  last_used?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Neighbor/Advert Types
// ═══════════════════════════════════════════════════════════════════════════

export interface AdvertsByContactTypeResponse {
  adverts: NeighborInfo[];
  count: number;
  contact_type: string;
  filters: {
    contact_type: string;
    limit: number | null;
    hours: number | null;
  };
}

