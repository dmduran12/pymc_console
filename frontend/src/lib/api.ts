// API Client for pyMC Repeater backend
// Features: SWR caching, request deduplication, background revalidation

import { calculateAirtimeMs, radioConfigFromStats } from '@/lib/airtime';
import type {
  Stats,
  Packet,
  PacketFilters,
  LogEntry,
  ApiResponse,
  GraphData,
  HardwareStats,
  // Identity types
  Identity,
  IdentitiesResponse,
  IdentityCreateRequest,
  IdentityUpdateRequest,
  // ACL types
  ACLInfoResponse,
  ACLClientsResponse,
  ACLStats,
  // Room Server types
  RoomMessagesResponse,
  RoomPostMessageRequest,
  RoomPostMessageResponse,
  RoomStatsResponse,
  RoomClientsResponse,
  // Transport types
  TransportKey,
  TransportKeyCreateRequest,
  TransportKeyUpdateRequest,
  // Neighbor types
  AdvertsByContactTypeResponse,
} from '@/types/api';

// Empty string = same-origin (relative URLs work when served from pyMC_Repeater)
const API_BASE = import.meta.env.VITE_API_URL || '';

// ═══════════════════════════════════════════════════════════════════════════
// SWR Cache Configuration
// ═══════════════════════════════════════════════════════════════════════════

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number; // Time-to-live in ms
}

// In-memory cache with LRU eviction
const cache = new Map<string, CacheEntry<unknown>>();
const MAX_CACHE_SIZE = 50;
const STALE_THRESHOLD = 5 * 60 * 1000; // 5 minutes - entries older than this are evicted

// Track in-flight requests for deduplication
const inFlightRequests = new Map<string, Promise<unknown>>();

// TTL configuration by endpoint pattern (in milliseconds)
const TTL_CONFIG: Record<string, number> = {
  '/api/stats': 2000,
  '/api/logs': 1000,
  '/api/recent_packets': 2000,
  '/api/hardware_stats': 3000,
  '/api/packet_type_graph_data': 30000,
  '/api/metrics_graph_data': 30000,
  '/api/noise_floor_history': 30000,
  '/api/radio_presets': 60000,
  default: 5000,
};

function getTTL(endpoint: string): number {
  // Find matching TTL config by endpoint prefix
  for (const [pattern, ttl] of Object.entries(TTL_CONFIG)) {
    if (pattern !== 'default' && endpoint.startsWith(pattern)) {
      return ttl;
    }
  }
  return TTL_CONFIG.default;
}

function getCacheKey(endpoint: string, options?: RequestInit): string {
  // Only cache GET requests
  if (options?.method && options.method !== 'GET') {
    return '';
  }
  return endpoint;
}

function cleanupCache(): void {
  const now = Date.now();
  
  // Remove stale entries (older than STALE_THRESHOLD)
  for (const [key, entry] of cache.entries()) {
    if (now - entry.timestamp > STALE_THRESHOLD) {
      cache.delete(key);
    }
  }
  
  // LRU eviction if still over max size
  if (cache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(cache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = entries.slice(0, entries.length - MAX_CACHE_SIZE);
    for (const [key] of toRemove) {
      cache.delete(key);
    }
  }
}

function setCache<T>(key: string, data: T, ttl: number): void {
  if (!key) return;
  cache.set(key, { data, timestamp: Date.now(), ttl });
  cleanupCache();
}

function getCache<T>(key: string): { data: T; isStale: boolean } | null {
  if (!key) return null;
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  
  const age = Date.now() - entry.timestamp;
  const isStale = age > entry.ttl;
  
  return { data: entry.data, isStale };
}

// Clear cache on tab visibility change (user returns to tab)
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Mark all entries as stale by setting their timestamp to old value
      for (const entry of cache.values()) {
        entry.timestamp = 0;
      }
    }
  });
}

// Export for manual cache invalidation
export function invalidateCache(pattern?: string): void {
  if (!pattern) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.includes(pattern)) {
      cache.delete(key);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Core Fetch Function with SWR
// ═══════════════════════════════════════════════════════════════════════════

// Raw fetch without caching (for mutations and internal use)
async function fetchRaw<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  
  // Only include Content-Type for requests with a body (POST, PUT, etc.)
  const headers: Record<string, string> = {};
  if (options?.headers) {
    const h = options.headers;
    if (h instanceof Headers) {
      h.forEach((v, k) => { headers[k] = v; });
    } else if (Array.isArray(h)) {
      h.forEach(([k, v]) => { headers[k] = v; });
    } else {
      Object.assign(headers, h);
    }
  }
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }
  
  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

// SWR-enabled fetch: returns cached data immediately, revalidates in background
async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const cacheKey = getCacheKey(endpoint, options);
  const ttl = getTTL(endpoint);
  
  // For non-GET requests, skip caching
  if (!cacheKey) {
    return fetchRaw<T>(endpoint, options);
  }
  
  // Check cache first
  const cached = getCache<T>(cacheKey);
  
  // If we have fresh cached data, return it immediately
  if (cached && !cached.isStale) {
    return cached.data;
  }
  
  // Check for in-flight request (deduplication)
  const inFlight = inFlightRequests.get(cacheKey);
  if (inFlight) {
    // If we have stale data, return it while waiting for in-flight request
    if (cached) {
      // Don't await - let the in-flight request update cache in background
      return cached.data;
    }
    // No cached data, wait for in-flight request
    return inFlight as Promise<T>;
  }
  
  // Start new request
  const fetchPromise = fetchRaw<T>(endpoint, options)
    .then((data) => {
      setCache(cacheKey, data, ttl);
      inFlightRequests.delete(cacheKey);
      return data;
    })
    .catch((error) => {
      inFlightRequests.delete(cacheKey);
      throw error;
    });
  
  inFlightRequests.set(cacheKey, fetchPromise);
  
  // If we have stale cached data, return it immediately
  // The fetch will update the cache in the background
  if (cached) {
    // Fire and forget - update cache in background
    fetchPromise.catch(() => {}); // Suppress unhandled rejection
    return cached.data;
  }
  
  // No cached data, wait for fetch
  return fetchPromise;
}

// ═══════════════════════════════════════════════════════════════════════════
// Data Normalization Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalize contact_type values from API to MeshCore terminology.
 * "Chat Node" (pymc_core) → "Companion" (MeshCore terminology)
 */
function normalizeContactType(contactType: string | undefined): string | undefined {
  if (!contactType) return contactType;
  // Normalize "Chat Node" → "Companion" to match MeshCore terminology
  if (contactType.toLowerCase() === 'chat node') return 'Companion';
  return contactType;
}

/**
 * Normalize Stats response - transforms API values to frontend conventions.
 */
function normalizeStats(stats: Stats): Stats {
  // Normalize contact_type for all neighbors
  if (stats.neighbors) {
    for (const neighbor of Object.values(stats.neighbors)) {
      neighbor.contact_type = normalizeContactType(neighbor.contact_type);
    }
  }
  return stats;
}

// Stats endpoints
export async function getStats(): Promise<Stats> {
  const stats = await fetchApi<Stats>('/api/stats');
  return normalizeStats(stats);
}

// Logs endpoint
export async function getLogs(): Promise<{ logs: LogEntry[] }> {
  return fetchApi<{ logs: LogEntry[] }>('/api/logs');
}

// Packet endpoints
export async function getRecentPackets(limit = 100): Promise<ApiResponse<Packet[]>> {
  return fetchApi<ApiResponse<Packet[]>>(`/api/recent_packets?limit=${limit}`);
}

// Client-side packet filtering using recent_packets
// (filtered_packets endpoint has upstream compatibility issues)
export async function getFilteredPackets(filters: PacketFilters): Promise<ApiResponse<Packet[]>> {
  // Fetch recent packets and filter client-side
  const fetchLimit = Math.max(filters.limit || 1000, 5000);
  const response = await getRecentPackets(fetchLimit);
  
  if (!response.success || !response.data) {
    return response;
  }
  
  let packets = response.data;
  
  // Apply filters client-side
  if (filters.type !== undefined) {
    packets = packets.filter(p => (p.type ?? p.payload_type) === filters.type);
  }
  if (filters.route !== undefined) {
    packets = packets.filter(p => (p.route ?? p.route_type) === filters.route);
  }
  if (filters.start_timestamp) {
    packets = packets.filter(p => p.timestamp >= filters.start_timestamp!);
  }
  if (filters.end_timestamp) {
    packets = packets.filter(p => p.timestamp <= filters.end_timestamp!);
  }
  
  // Apply final limit
  if (filters.limit && packets.length > filters.limit) {
    packets = packets.slice(0, filters.limit);
  }
  
  return { success: true, data: packets, count: packets.length };
}

export async function getPacketByHash(hash: string): Promise<ApiResponse<Packet>> {
  return fetchApi<ApiResponse<Packet>>(`/api/packet_by_hash?packet_hash=${hash}`);
}

// Chart data endpoints
export async function getPacketTypeGraphData(hours = 24): Promise<ApiResponse<GraphData>> {
  return fetchApi<ApiResponse<GraphData>>(`/api/packet_type_graph_data?hours=${hours}`);
}

export async function getMetricsGraphData(hours = 24): Promise<ApiResponse<GraphData>> {
  return fetchApi<ApiResponse<GraphData>>(`/api/metrics_graph_data?hours=${hours}`);
}

// Noise floor history - returns array of {timestamp, noise_floor_dbm}
export interface NoiseFloorHistoryItem {
  timestamp: number;
  noise_floor_dbm: number;
}

export interface NoiseFloorHistoryResponse {
  history: NoiseFloorHistoryItem[];
  hours: number;
  count: number;
}

export async function getNoiseFloorHistory(hours = 24): Promise<ApiResponse<NoiseFloorHistoryResponse>> {
  return fetchApi<ApiResponse<NoiseFloorHistoryResponse>>(`/api/noise_floor_history?hours=${hours}`);
}

// Hardware stats
export async function getHardwareStats(): Promise<ApiResponse<HardwareStats>> {
  return fetchApi<ApiResponse<HardwareStats>>('/api/hardware_stats');
}

// Control endpoints
// Note: CherryPy requires Content-Length header for POST, so we send empty JSON body
export async function sendAdvert(): Promise<ApiResponse<string>> {
  return fetchApi<ApiResponse<string>>('/api/send_advert', {
    method: 'POST',
    body: '{}',
  });
}

export async function setMode(mode: 'forward' | 'monitor'): Promise<{ success: boolean; mode: string }> {
  return fetchApi<{ success: boolean; mode: string }>('/api/set_mode', {
    method: 'POST',
    body: JSON.stringify({ mode }),
  });
}

export async function setDutyCycle(enabled: boolean): Promise<{ success: boolean; enabled: boolean }> {
  return fetchApi<{ success: boolean; enabled: boolean }>('/api/set_duty_cycle', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
}

// Packet stats
export async function getPacketStats(hours = 24): Promise<ApiResponse<Record<string, number>>> {
  return fetchApi<ApiResponse<Record<string, number>>>(`/api/packet_stats?hours=${hours}`);
}

export async function getPacketTypeStats(hours = 24): Promise<ApiResponse<Record<string, number>>> {
  return fetchApi<ApiResponse<Record<string, number>>>(`/api/packet_type_stats?hours=${hours}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Bucketed Stats for Airtime Utilization Chart
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bucket data for airtime utilization visualization
 * Includes both packet counts and total airtime for proper utilization calculation
 */
export interface BucketData {
  bucket: number;
  start: number;
  end: number;
  count: number;
  /** Total airtime in milliseconds for all packets in this bucket */
  airtime_ms: number;
  avg_snr: number;
  avg_rssi: number;
}

export interface BucketedStats {
  time_range_minutes: number;
  bucket_count: number;
  bucket_duration_seconds: number;
  start_time: number;
  end_time: number;
  received: BucketData[];
  transmitted: BucketData[];
  forwarded: BucketData[];
  dropped: BucketData[];
}

/**
 * Compute bucketed stats client-side from filtered_packets
 * 
 * Uses proper LoRa airtime calculation (Semtech formula) for accurate
 * TX/RX utilization percentages. Fetches stats to get radio config.
 * 
 * @param minutes - Time range in minutes
 * @param bucketCount - Number of buckets (1440 recommended for high resolution)
 */
export async function getBucketedStats(minutes = 20, bucketCount = 20): Promise<ApiResponse<BucketedStats>> {
  try {
    const endTime = Math.floor(Date.now() / 1000);
    const startTime = endTime - (minutes * 60);
    const bucketDuration = (minutes * 60) / bucketCount;
    
    // Scale limit based on time range to avoid capping data for longer periods
    // Rough estimate: ~500 packets/hour at busy times, with 2x buffer
    const estimatedPackets = Math.ceil((minutes / 60) * 1000);
    const limit = Math.max(5000, Math.min(estimatedPackets, 50000));
    
    // Fetch packets and stats in parallel
    const [packetsResponse, stats] = await Promise.all([
      getFilteredPackets({
        start_timestamp: startTime,
        end_timestamp: endTime,
        limit,
      }),
      getStats(),
    ]);
    
    if (!packetsResponse.success || !packetsResponse.data) {
      return { success: false, error: packetsResponse.error || 'Failed to fetch packets' };
    }
    
    const packets = packetsResponse.data;
    
    // Get radio config for proper airtime calculation
    const radioConfig = radioConfigFromStats(stats);
    
    // Initialize buckets with airtime_ms field
    const createEmptyBuckets = (): BucketData[] => {
      const buckets: BucketData[] = [];
      for (let i = 0; i < bucketCount; i++) {
        buckets.push({
          bucket: i,
          start: startTime + (i * bucketDuration),
          end: startTime + ((i + 1) * bucketDuration),
          count: 0,
          airtime_ms: 0,
          avg_snr: 0,
          avg_rssi: 0,
        });
      }
      return buckets;
    };
    
    const received = createEmptyBuckets();
    const transmitted = createEmptyBuckets();
    const forwarded = createEmptyBuckets();
    const dropped = createEmptyBuckets();
    
    // Track SNR/RSSI sums for averaging
    const rxSums = received.map(() => ({ snr: 0, rssi: 0, count: 0 }));
    
    // Categorize packets into buckets and calculate airtime
    for (const pkt of packets) {
      const bucketIdx = Math.floor((pkt.timestamp - startTime) / bucketDuration);
      if (bucketIdx < 0 || bucketIdx >= bucketCount) continue;
      
      // Calculate airtime for this packet using proper LoRa formula
      const pktLen = pkt.length || pkt.payload_length || 32;
      const airtime = calculateAirtimeMs(pktLen, radioConfig);
      
      // Determine packet category
      const origin = pkt.packet_origin;
      if (origin === 'tx_local') {
        transmitted[bucketIdx].count++;
        transmitted[bucketIdx].airtime_ms += airtime;
      } else if (origin === 'tx_forward' || pkt.transmitted) {
        forwarded[bucketIdx].count++;
        forwarded[bucketIdx].airtime_ms += airtime;
      } else if (pkt.drop_reason) {
        dropped[bucketIdx].count++;
        dropped[bucketIdx].airtime_ms += airtime;
      }
      
      // All non-local packets count as received
      if (origin !== 'tx_local') {
        received[bucketIdx].count++;
        received[bucketIdx].airtime_ms += airtime;
        rxSums[bucketIdx].snr += pkt.snr || 0;
        rxSums[bucketIdx].rssi += pkt.rssi || 0;
        rxSums[bucketIdx].count++;
      }
    }
    
    // Calculate averages
    for (let i = 0; i < bucketCount; i++) {
      if (rxSums[i].count > 0) {
        received[i].avg_snr = rxSums[i].snr / rxSums[i].count;
        received[i].avg_rssi = rxSums[i].rssi / rxSums[i].count;
      }
    }
    
    return {
      success: true,
      data: {
        time_range_minutes: minutes,
        bucket_count: bucketCount,
        bucket_duration_seconds: bucketDuration,
        start_time: startTime,
        end_time: endTime,
        received,
        transmitted,
        forwarded,
        dropped,
      },
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// Radio configuration types
export interface RadioPreset {
  title: string;
  description: string;
  frequency: string;
  spreading_factor: string;
  bandwidth: string;
  coding_rate: string;
}

export interface RadioConfigUpdate {
  frequency_mhz?: number;
  bandwidth_khz?: number;
  spreading_factor?: number;
  coding_rate?: number;
  tx_power?: number;
  node_name?: string;
  // Delay settings
  tx_delay_factor?: number;        // af/txdelay (0.0-5.0)
  direct_tx_delay_factor?: number; // direct.txdelay (0.0-5.0)
}

export interface RadioConfigResult {
  applied: string[];
  persisted: boolean;
  live_update: boolean;
  warnings?: string[];
}

// Radio configuration endpoints
export async function getRadioPresets(): Promise<ApiResponse<RadioPreset[]>> {
  return fetchApi<ApiResponse<RadioPreset[]>>('/api/radio_presets');
}

export async function updateRadioConfig(config: RadioConfigUpdate): Promise<ApiResponse<RadioConfigResult>> {
  return fetchApi<ApiResponse<RadioConfigResult>>('/api/update_radio_config', {
    method: 'POST',
    body: JSON.stringify(config),
  });
}

// Log level types
export type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

export interface LogLevelResult {
  level: LogLevel;
  restarting: boolean;
  message: string;
}

// Set log level (triggers service restart)
export async function setLogLevel(level: LogLevel): Promise<ApiResponse<LogLevelResult>> {
  return fetchApi<ApiResponse<LogLevelResult>>('/api/set_log_level', {
    method: 'POST',
    body: JSON.stringify({ level }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Identity Management Endpoints (feat/identity branch)
// ═══════════════════════════════════════════════════════════════════════════

// List all identities (repeater + room servers)
export async function getIdentities(): Promise<ApiResponse<IdentitiesResponse>> {
  return fetchApi<ApiResponse<IdentitiesResponse>>('/api/identities');
}

// Get specific identity by name
export async function getIdentity(name: string): Promise<ApiResponse<Identity>> {
  return fetchApi<ApiResponse<Identity>>(`/api/identity?name=${encodeURIComponent(name)}`);
}

// Create a new identity (auto-generates key if not provided)
export async function createIdentity(request: IdentityCreateRequest): Promise<ApiResponse<Identity & { message: string }>> {
  return fetchApi<ApiResponse<Identity & { message: string }>>('/api/create_identity', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

// Update an existing identity
export async function updateIdentity(request: IdentityUpdateRequest): Promise<ApiResponse<Identity & { message: string }>> {
  return fetchApi<ApiResponse<Identity & { message: string }>>('/api/update_identity', {
    method: 'PUT',
    body: JSON.stringify(request),
  });
}

// Delete an identity
export async function deleteIdentity(name: string): Promise<ApiResponse<{ name: string; message: string }>> {
  return fetchApi<ApiResponse<{ name: string; message: string }>>(`/api/delete_identity?name=${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

// Send advert for a room server
export async function sendRoomServerAdvert(name: string): Promise<ApiResponse<{
  name: string;
  node_name: string;
  latitude: number;
  longitude: number;
  message: string;
}>> {
  return fetchApi('/api/send_room_server_advert', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ACL (Access Control List) Endpoints
// ═══════════════════════════════════════════════════════════════════════════

// Get ACL config and stats for all identities
export async function getACLInfo(): Promise<ApiResponse<ACLInfoResponse>> {
  return fetchApi<ApiResponse<ACLInfoResponse>>('/api/acl_info');
}

// List authenticated clients (optionally filtered by identity)
export async function getACLClients(params?: {
  identity_hash?: string;
  identity_name?: string;
}): Promise<ApiResponse<ACLClientsResponse>> {
  const queryParams = new URLSearchParams();
  if (params?.identity_hash) queryParams.set('identity_hash', params.identity_hash);
  if (params?.identity_name) queryParams.set('identity_name', params.identity_name);
  const query = queryParams.toString();
  return fetchApi<ApiResponse<ACLClientsResponse>>(`/api/acl_clients${query ? '?' + query : ''}`);
}

// Remove a client from ACL
export async function removeACLClient(params: {
  public_key: string;
  identity_hash?: string;
}): Promise<ApiResponse<{ removed_count: number; removed_from: string[]; message: string }>> {
  return fetchApi('/api/acl_remove_client', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

// Get overall ACL statistics
export async function getACLStats(): Promise<ApiResponse<ACLStats>> {
  return fetchApi<ApiResponse<ACLStats>>('/api/acl_stats');
}

// ═══════════════════════════════════════════════════════════════════════════
// Room Server Endpoints
// ═══════════════════════════════════════════════════════════════════════════

// Get messages from a room
export async function getRoomMessages(params: {
  room_name?: string;
  room_hash?: string;
  limit?: number;
  offset?: number;
  since_timestamp?: number;
}): Promise<ApiResponse<RoomMessagesResponse>> {
  const queryParams = new URLSearchParams();
  if (params.room_name) queryParams.set('room_name', params.room_name);
  if (params.room_hash) queryParams.set('room_hash', params.room_hash);
  if (params.limit !== undefined) queryParams.set('limit', params.limit.toString());
  if (params.offset !== undefined) queryParams.set('offset', params.offset.toString());
  if (params.since_timestamp !== undefined) queryParams.set('since_timestamp', params.since_timestamp.toString());
  return fetchApi<ApiResponse<RoomMessagesResponse>>(`/api/room_messages?${queryParams.toString()}`);
}

// Post a message to a room
export async function postRoomMessage(request: RoomPostMessageRequest): Promise<ApiResponse<RoomPostMessageResponse>> {
  return fetchApi<ApiResponse<RoomPostMessageResponse>>('/api/room_post_message', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

// Get room statistics (one room or all rooms)
export async function getRoomStats(params?: {
  room_name?: string;
  room_hash?: string;
}): Promise<ApiResponse<RoomStatsResponse>> {
  const queryParams = new URLSearchParams();
  if (params?.room_name) queryParams.set('room_name', params.room_name);
  if (params?.room_hash) queryParams.set('room_hash', params.room_hash);
  const query = queryParams.toString();
  return fetchApi<ApiResponse<RoomStatsResponse>>(`/api/room_stats${query ? '?' + query : ''}`);
}

// Get clients synced to a room
export async function getRoomClients(params: {
  room_name?: string;
  room_hash?: string;
}): Promise<ApiResponse<RoomClientsResponse>> {
  const queryParams = new URLSearchParams();
  if (params.room_name) queryParams.set('room_name', params.room_name);
  if (params.room_hash) queryParams.set('room_hash', params.room_hash);
  return fetchApi<ApiResponse<RoomClientsResponse>>(`/api/room_clients?${queryParams.toString()}`);
}

// Delete a specific message from a room
export async function deleteRoomMessage(params: {
  room_name?: string;
  room_hash?: string;
  message_id: number;
}): Promise<ApiResponse<{ message: string }>> {
  const queryParams = new URLSearchParams();
  if (params.room_name) queryParams.set('room_name', params.room_name);
  if (params.room_hash) queryParams.set('room_hash', params.room_hash);
  queryParams.set('message_id', params.message_id.toString());
  return fetchApi<ApiResponse<{ message: string }>>(`/api/room_message?${queryParams.toString()}`, {
    method: 'DELETE',
  });
}

// Clear all messages in a room
export async function clearRoomMessages(params: {
  room_name?: string;
  room_hash?: string;
}): Promise<ApiResponse<{ message: string; deleted_count: number }>> {
  const queryParams = new URLSearchParams();
  if (params.room_name) queryParams.set('room_name', params.room_name);
  if (params.room_hash) queryParams.set('room_hash', params.room_hash);
  return fetchApi<ApiResponse<{ message: string; deleted_count: number }>>(`/api/room_messages?${queryParams.toString()}`, {
    method: 'DELETE',
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Transport Key Endpoints
// ═══════════════════════════════════════════════════════════════════════════

// List all transport keys
export async function getTransportKeys(): Promise<ApiResponse<TransportKey[]>> {
  return fetchApi<ApiResponse<TransportKey[]>>('/api/transport_keys');
}

// Create a new transport key
export async function createTransportKey(request: TransportKeyCreateRequest): Promise<ApiResponse<{ id: number; message: string }>> {
  return fetchApi('/api/transport_keys', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

// Get a specific transport key by ID
export async function getTransportKey(keyId: number): Promise<ApiResponse<TransportKey>> {
  return fetchApi<ApiResponse<TransportKey>>(`/api/transport_key/${keyId}`);
}

// Update a transport key
export async function updateTransportKey(keyId: number, request: TransportKeyUpdateRequest): Promise<ApiResponse<{ id: number; message: string }>> {
  return fetchApi(`/api/transport_key/${keyId}`, {
    method: 'PUT',
    body: JSON.stringify(request),
  });
}

// Delete a transport key
export async function deleteTransportKey(keyId: number): Promise<ApiResponse<{ id: number; message: string }>> {
  return fetchApi(`/api/transport_key/${keyId}`, {
    method: 'DELETE',
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Mesh/Flood Policy Endpoints
// ═══════════════════════════════════════════════════════════════════════════

// Update global flood policy
export async function setGlobalFloodPolicy(allow: boolean): Promise<ApiResponse<{
  global_flood_allow: boolean;
  message: string;
}>> {
  return fetchApi('/api/global_flood_policy', {
    method: 'POST',
    body: JSON.stringify({ global_flood_allow: allow }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Neighbor/Advert Endpoints
// ═══════════════════════════════════════════════════════════════════════════

// Delete a neighbor/advert
export async function deleteAdvert(advertId: number): Promise<ApiResponse<{ id: number; message: string }>> {
  return fetchApi(`/api/advert/${advertId}`, {
    method: 'DELETE',
  });
}

// Ping a neighbor (placeholder - not fully implemented upstream)
export async function pingNeighbor(targetId: string): Promise<ApiResponse<{ target_id: string; message: string }>> {
  return fetchApi('/api/ping_neighbor', {
    method: 'POST',
    body: JSON.stringify({ target_id: targetId }),
  });
}

// Get adverts filtered by contact type
export async function getAdvertsByContactType(params: {
  contact_type: string;
  limit?: number;
  hours?: number;
}): Promise<ApiResponse<AdvertsByContactTypeResponse>> {
  const queryParams = new URLSearchParams();
  queryParams.set('contact_type', params.contact_type);
  if (params.limit !== undefined) queryParams.set('limit', params.limit.toString());
  if (params.hours !== undefined) queryParams.set('hours', params.hours.toString());
  return fetchApi<ApiResponse<AdvertsByContactTypeResponse>>(`/api/adverts_by_contact_type?${queryParams.toString()}`);
}


