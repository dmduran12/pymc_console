/**
 * LoRa Airtime Calculation Utility
 * 
 * Provides accurate airtime estimation for LoRa packets based on the Semtech
 * reference implementation. This is critical for calculating channel utilization.
 * 
 * Reference: https://www.semtech.com/design-support/lora-calculator
 * 
 * Key formulas:
 * - Symbol time: T_sym = 2^SF / BW
 * - Preamble time: T_preamble = (n_preamble + 4.25) * T_sym
 * - Payload symbols: n_payload = 8 + ceil((8*PL - 4*SF + 28 + 16*CRC - 20*H) / (4*(SF-2*DE))) * CR
 * - Total time: T_packet = T_preamble + n_payload * T_sym
 * 
 * Where:
 * - SF = Spreading Factor (7-12)
 * - BW = Bandwidth in Hz
 * - PL = Payload length in bytes
 * - CRC = 1 if CRC enabled, 0 otherwise
 * - H = 0 for explicit header, 1 for implicit header
 * - DE = 1 for low data rate optimize (SF >= 11 at 125kHz), 0 otherwise
 * - CR = Coding rate (5 for 4/5, 6 for 4/6, 7 for 4/7, 8 for 4/8)
 */

/**
 * Radio configuration for airtime calculation
 */
export interface RadioConfig {
  /** Spreading factor (7-12) */
  spreadingFactor: number;
  /** Bandwidth in Hz (e.g., 125000, 250000, 500000) */
  bandwidthHz: number;
  /** Coding rate denominator (5 = 4/5, 6 = 4/6, etc.) */
  codingRate: number;
  /** Preamble length in symbols (typically 8) */
  preambleLength?: number;
  /** Whether CRC is enabled (default: true) */
  crcEnabled?: boolean;
  /** Whether explicit header mode is used (default: true) */
  explicitHeader?: boolean;
}

/**
 * Default radio config matching MeshCore defaults
 */
export const DEFAULT_RADIO_CONFIG: RadioConfig = {
  spreadingFactor: 7,
  bandwidthHz: 125000,
  codingRate: 5,
  preambleLength: 8,
  crcEnabled: true,
  explicitHeader: true,
};

/**
 * Calculate LoRa packet airtime in milliseconds
 * 
 * Uses the proper Semtech formula for accurate airtime estimation.
 * This matches what MeshCore firmware uses internally.
 * 
 * @param payloadBytes - Payload length in bytes
 * @param config - Radio configuration
 * @returns Airtime in milliseconds
 */
export function calculateAirtimeMs(
  payloadBytes: number,
  config: Partial<RadioConfig> = {}
): number {
  // Merge with defaults
  const sf = config.spreadingFactor ?? DEFAULT_RADIO_CONFIG.spreadingFactor;
  const bwHz = config.bandwidthHz ?? DEFAULT_RADIO_CONFIG.bandwidthHz;
  const cr = config.codingRate ?? DEFAULT_RADIO_CONFIG.codingRate;
  const preamble = config.preambleLength ?? DEFAULT_RADIO_CONFIG.preambleLength ?? 8;
  const crc = (config.crcEnabled ?? DEFAULT_RADIO_CONFIG.crcEnabled) ? 1 : 0;
  const h = (config.explicitHeader ?? DEFAULT_RADIO_CONFIG.explicitHeader) ? 0 : 1;
  
  // Low data rate optimize: required for SF11/SF12 at 125kHz
  const de = (sf >= 11 && bwHz <= 125000) ? 1 : 0;
  
  // Symbol time in milliseconds
  // T_sym = 2^SF / BW_kHz (when BW is in kHz, result is in ms)
  const bwKhz = bwHz / 1000;
  const tSym = Math.pow(2, sf) / bwKhz;
  
  // Preamble time
  const tPreamble = (preamble + 4.25) * tSym;
  
  // Payload symbol calculation
  // n_payload = 8 + ceil(max(8*PL - 4*SF + 28 + 16*CRC - 20*H, 0) / (4*(SF - 2*DE))) * CR
  const numerator = Math.max(8 * payloadBytes - 4 * sf + 28 + 16 * crc - 20 * h, 0);
  const denominator = 4 * (sf - 2 * de);
  const nPayload = 8 + Math.ceil(numerator / denominator) * cr;
  
  // Payload time
  const tPayload = nPayload * tSym;
  
  // Total packet time
  return tPreamble + tPayload;
}

/**
 * Calculate airtime utilization percentage
 * 
 * @param airtimeMs - Total airtime in milliseconds
 * @param periodMs - Time period in milliseconds
 * @returns Utilization as a percentage (0-100+)
 */
export function calculateUtilizationPercent(airtimeMs: number, periodMs: number): number {
  if (periodMs <= 0) return 0;
  return (airtimeMs / periodMs) * 100;
}

/**
 * Estimate total RX airtime for a set of packets
 * 
 * @param packets - Array of packets with length property
 * @param config - Radio configuration
 * @returns Total airtime in milliseconds
 */
export function estimateTotalAirtimeMs(
  packets: Array<{ length?: number; payload_length?: number }>,
  config: Partial<RadioConfig> = {}
): number {
  return packets.reduce((total, pkt) => {
    const len = pkt.length ?? pkt.payload_length ?? 32;
    return total + calculateAirtimeMs(len, config);
  }, 0);
}

/**
 * Create a radio config from API stats response
 * 
 * @param stats - Stats object from /api/stats
 * @returns RadioConfig suitable for airtime calculation
 */
export function radioConfigFromStats(stats: {
  config?: {
    radio?: {
      spreading_factor?: number;
      bandwidth?: number;
      coding_rate?: number;
      preamble_length?: number;
    };
  };
} | null): RadioConfig {
  const radio = stats?.config?.radio;
  
  return {
    spreadingFactor: radio?.spreading_factor ?? DEFAULT_RADIO_CONFIG.spreadingFactor,
    bandwidthHz: radio?.bandwidth ?? DEFAULT_RADIO_CONFIG.bandwidthHz,
    codingRate: radio?.coding_rate ?? DEFAULT_RADIO_CONFIG.codingRate,
    preambleLength: radio?.preamble_length ?? DEFAULT_RADIO_CONFIG.preambleLength,
    crcEnabled: true,
    explicitHeader: true,
  };
}
