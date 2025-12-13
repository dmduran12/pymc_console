// API Client for pyMC Repeater backend

import type {
  Stats,
  Packet,
  PacketFilters,
  LogEntry,
  ApiResponse,
  GraphData,
  HardwareStats,
} from '@/types/api';

// Empty string = same-origin (relative URLs work when served from pyMC_Repeater)
const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  
  // Only include Content-Type for requests with a body (POST, PUT, etc.)
  // This avoids triggering CORS preflight on GET requests
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

// Stats endpoints
export async function getStats(): Promise<Stats> {
  return fetchApi<Stats>('/api/stats');
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

export async function getNoiseFloorChartData(hours = 24): Promise<ApiResponse<{ chart_data: GraphData }>> {
  return fetchApi<ApiResponse<{ chart_data: GraphData }>>(`/api/noise_floor_chart_data?hours=${hours}`);
}

// Hardware stats
export async function getHardwareStats(): Promise<ApiResponse<HardwareStats>> {
  return fetchApi<ApiResponse<HardwareStats>>('/api/hardware_stats');
}

// Control endpoints
export async function sendAdvert(): Promise<ApiResponse<string>> {
  return fetchApi<ApiResponse<string>>('/api/send_advert', {
    method: 'POST',
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

// Bucketed stats for dashboard visualization
export interface BucketData {
  bucket: number;
  start: number;
  end: number;
  count: number;
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

// Compute bucketed stats client-side from filtered_packets
export async function getBucketedStats(minutes = 20, bucketCount = 20): Promise<ApiResponse<BucketedStats>> {
  try {
    const endTime = Math.floor(Date.now() / 1000);
    const startTime = endTime - (minutes * 60);
    const bucketDuration = (minutes * 60) / bucketCount;
    
    // Fetch packets for the time range
    const response = await getFilteredPackets({
      start_timestamp: startTime,
      end_timestamp: endTime,
      limit: 5000,
    });
    
    if (!response.success || !response.data) {
      return { success: false, error: response.error || 'Failed to fetch packets' };
    }
    
    const packets = response.data;
    
    // Initialize buckets
    const createEmptyBuckets = (): BucketData[] => {
      const buckets: BucketData[] = [];
      for (let i = 0; i < bucketCount; i++) {
        buckets.push({
          bucket: i,
          start: startTime + (i * bucketDuration),
          end: startTime + ((i + 1) * bucketDuration),
          count: 0,
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
    
    // Categorize packets into buckets
    for (const pkt of packets) {
      const bucketIdx = Math.floor((pkt.timestamp - startTime) / bucketDuration);
      if (bucketIdx < 0 || bucketIdx >= bucketCount) continue;
      
      // Determine packet category
      const origin = pkt.packet_origin;
      if (origin === 'tx_local') {
        transmitted[bucketIdx].count++;
      } else if (origin === 'tx_forward' || pkt.transmitted) {
        forwarded[bucketIdx].count++;
      } else if (pkt.drop_reason) {
        dropped[bucketIdx].count++;
      }
      
      // All non-local packets count as received
      if (origin !== 'tx_local') {
        received[bucketIdx].count++;
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

// Airtime utilization stats
export interface UtilizationBin {
  t: number; // bin start timestamp in ms
  tx_airtime_ms: number;
  rx_airtime_ms: number;
  tx_pkts: number;
  rx_pkts_ok: number;
  tx_util_pct: number;
  rx_util_decoded_pct: number;
  radio_activity_pct: number;
  avg_rx_airtime_ms_per_pkt: number;
  avg_tx_airtime_ms_per_pkt: number;
}

export interface UtilizationStats {
  bins: UtilizationBin[];
  bin_duration_seconds: number;
  hours: number;
  anomaly_counters: {
    missing_airtime_ms: number;
    outlier_bins: number;
  };
}

// Estimate airtime for a packet based on LoRa parameters
// Matches the simplified calculation in pyMC_Repeater/repeater/airtime.py
function estimateAirtimeMs(
  payloadLen: number,
  spreadingFactor: number = 8,
  bandwidthHz: number = 125000
): number {
  const bwKhz = bandwidthHz / 1000;
  const symbolTime = Math.pow(2, spreadingFactor) / bwKhz;
  const preambleTime = 8 * symbolTime;
  const payloadSymbols = (payloadLen + 4.25) * 8;
  const payloadTime = payloadSymbols * symbolTime;
  return preambleTime + payloadTime;
}

// Compute utilization stats client-side from filtered_packets and stats
export async function getUtilizationStats(hours = 24): Promise<ApiResponse<UtilizationStats>> {
  try {
    const endTime = Math.floor(Date.now() / 1000);
    const startTime = endTime - (hours * 3600);
    const binDurationSeconds = 3600; // 1 hour bins
    const binCount = hours;
    
    // Fetch packets and stats in parallel
    const [packetsResponse, stats] = await Promise.all([
      getFilteredPackets({
        start_timestamp: startTime,
        end_timestamp: endTime,
        limit: 50000, // Large limit for 24h of data
      }),
      getStats(),
    ]);
    
    if (!packetsResponse.success || !packetsResponse.data) {
      return { success: false, error: packetsResponse.error || 'Failed to fetch packets' };
    }
    
    const packets = packetsResponse.data;
    
    // Get radio config for airtime calculation
    const sf = stats.config?.radio?.spreading_factor || 8;
    const bw = (stats.config?.radio?.bandwidth || 125) * 1000; // bandwidth is in kHz, convert to Hz
    
    // Initialize bins
    const bins: UtilizationBin[] = [];
    for (let i = 0; i < binCount; i++) {
      bins.push({
        t: (startTime + (i * binDurationSeconds)) * 1000, // Convert to ms for frontend
        tx_airtime_ms: 0,
        rx_airtime_ms: 0,
        tx_pkts: 0,
        rx_pkts_ok: 0,
        tx_util_pct: 0,
        rx_util_decoded_pct: 0,
        radio_activity_pct: 0,
        avg_rx_airtime_ms_per_pkt: 0,
        avg_tx_airtime_ms_per_pkt: 0,
      });
    }
    
    // Categorize packets into bins and calculate airtime
    for (const pkt of packets) {
      const binIdx = Math.floor((pkt.timestamp - startTime) / binDurationSeconds);
      if (binIdx < 0 || binIdx >= binCount) continue;
      
      // Get packet length (prefer 'length' field, fallback to payload_length)
      const pktLen = pkt.length || pkt.payload_length || 32;
      const airtime = estimateAirtimeMs(pktLen, sf, bw);
      
      const origin = pkt.packet_origin;
      if (origin === 'tx_local' || origin === 'tx_forward' || pkt.transmitted) {
        // Transmitted packet
        bins[binIdx].tx_airtime_ms += airtime;
        bins[binIdx].tx_pkts++;
      } else {
        // Received packet
        bins[binIdx].rx_airtime_ms += airtime;
        bins[binIdx].rx_pkts_ok++;
      }
    }
    
    // Calculate utilization percentages
    // Max airtime per bin = binDurationSeconds * 1000 ms
    const maxAirtimePerBin = binDurationSeconds * 1000;
    
    for (const bin of bins) {
      bin.tx_util_pct = (bin.tx_airtime_ms / maxAirtimePerBin) * 100;
      bin.rx_util_decoded_pct = (bin.rx_airtime_ms / maxAirtimePerBin) * 100;
      bin.radio_activity_pct = ((bin.tx_airtime_ms + bin.rx_airtime_ms) / maxAirtimePerBin) * 100;
      
      // Calculate averages
      if (bin.rx_pkts_ok > 0) {
        bin.avg_rx_airtime_ms_per_pkt = bin.rx_airtime_ms / bin.rx_pkts_ok;
      }
      if (bin.tx_pkts > 0) {
        bin.avg_tx_airtime_ms_per_pkt = bin.tx_airtime_ms / bin.tx_pkts;
      }
    }
    
    return {
      success: true,
      data: {
        bins,
        bin_duration_seconds: binDurationSeconds,
        hours,
        anomaly_counters: {
          missing_airtime_ms: 0,
          outlier_bins: 0,
        },
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
