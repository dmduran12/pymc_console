import { create } from 'zustand';
import type { Stats, Packet, LogEntry } from '@/types/api';
import * as api from '@/lib/api';

/** Data point for system resource history */
export interface ResourceDataPoint {
  timestamp: number;
  time: string;
  cpu: number;
  memory: number;
}

// localStorage key for resource history persistence
const RESOURCE_HISTORY_KEY = 'pymc-resource-history';
const RESOURCE_LAST_FETCH_KEY = 'pymc-resource-last-fetch';

/** Load resource history from localStorage */
function loadResourceHistory(): ResourceDataPoint[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(RESOURCE_HISTORY_KEY);
    if (stored) {
      return JSON.parse(stored) as ResourceDataPoint[];
    }
  } catch {
    // Ignore localStorage errors (e.g., in SSR or incognito)
  }
  return [];
}

/** Load last fetch timestamp from localStorage */
function loadLastResourceFetch(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const stored = localStorage.getItem(RESOURCE_LAST_FETCH_KEY);
    if (stored) {
      return parseInt(stored, 10) || 0;
    }
  } catch {
    // Ignore localStorage errors
  }
  return 0;
}

/** Save resource history to localStorage */
function saveResourceHistory(history: ResourceDataPoint[], lastFetch: number): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(RESOURCE_HISTORY_KEY, JSON.stringify(history));
    localStorage.setItem(RESOURCE_LAST_FETCH_KEY, lastFetch.toString());
  } catch {
    // Ignore localStorage errors (e.g., in SSR or incognito)
  }
}

interface StoreState {
  // Stats
  stats: Stats | null;
  statsLoading: boolean;
  statsError: string | null;

  // Packets
  packets: Packet[];
  packetsLoading: boolean;
  packetsError: string | null;
  lastPacketTimestamp: number; // Track newest packet timestamp to detect new arrivals

  // Logs
  logs: LogEntry[];
  logsLoading: boolean;

  // UI State
  liveMode: boolean;
  
  // Flash events for visual feedback
  flashReceived: number; // Increment to trigger flash
  flashAdvert: number;   // Increment to trigger flash

  // System resource history (persists across page navigation)
  resourceHistory: ResourceDataPoint[];
  lastResourceFetch: number; // Prevent duplicate entries

  // Actions
  fetchStats: () => Promise<void>;
  fetchPackets: (limit?: number) => Promise<void>;
  fetchLogs: () => Promise<void>;
  setLiveMode: (enabled: boolean) => void;
  setMode: (mode: 'forward' | 'monitor') => Promise<void>;
  setDutyCycle: (enabled: boolean) => Promise<void>;
  sendAdvert: () => Promise<boolean>;
  triggerFlashReceived: () => void;
  triggerFlashAdvert: () => void;
  addResourceDataPoint: (cpu: number, memory: number, maxSlots: number) => void;
}

const store = create<StoreState>((set, get) => ({
  // Initial state
  stats: null,
  statsLoading: false,
  statsError: null,

  packets: [],
  packetsLoading: false,
  packetsError: null,
  lastPacketTimestamp: 0,

  logs: [],
  logsLoading: false,

  liveMode: true,
  
  flashReceived: 0,
  flashAdvert: 0,

  resourceHistory: loadResourceHistory(),
  lastResourceFetch: loadLastResourceFetch(),

  // Actions
  fetchStats: async () => {
    set({ statsLoading: true, statsError: null });
    try {
      const stats = await api.getStats();
      // Flash trigger moved to fetchPackets where we have actual packet data
      set({ stats, statsLoading: false });
    } catch (error) {
      set({ 
        statsError: error instanceof Error ? error.message : 'Failed to fetch stats',
        statsLoading: false 
      });
    }
  },

  fetchPackets: async (limit = 50) => {
    set({ packetsLoading: true, packetsError: null });
    try {
      const response = await api.getRecentPackets(limit);
      if (response.success && response.data) {
        const newPackets = response.data;
        const { lastPacketTimestamp } = get();
        
        // Find newest packet timestamp from response
        const newestTimestamp = newPackets.length > 0 
          ? Math.max(...newPackets.map(p => p.timestamp ?? 0))
          : 0;
        
        // Trigger flash only if we have new packets (newer than last seen)
        // and this isn't the initial load (lastPacketTimestamp > 0)
        if (newestTimestamp > lastPacketTimestamp && lastPacketTimestamp > 0) {
          set({ flashReceived: get().flashReceived + 1 });
        }
        
        set({ 
          packets: newPackets, 
          packetsLoading: false,
          lastPacketTimestamp: newestTimestamp || lastPacketTimestamp,
        });
      } else {
        set({ packetsError: response.error || 'Failed to fetch packets', packetsLoading: false });
      }
    } catch (error) {
      set({ 
        packetsError: error instanceof Error ? error.message : 'Failed to fetch packets',
        packetsLoading: false 
      });
    }
  },

  fetchLogs: async () => {
    set({ logsLoading: true });
    try {
      const response = await api.getLogs();
      set({ logs: response.logs, logsLoading: false });
    } catch {
      set({ logsLoading: false });
    }
  },

  setLiveMode: (enabled) => {
    set({ liveMode: enabled });
  },

  setMode: async (mode) => {
    try {
      const response = await api.setMode(mode);
      if (response.success) {
        // Refresh stats to get updated mode
        await get().fetchStats();
      }
    } catch (error) {
      console.error('Failed to set mode:', error);
    }
  },

  setDutyCycle: async (enabled) => {
    try {
      const response = await api.setDutyCycle(enabled);
      if (response.success) {
        get().fetchStats();
      }
    } catch (error) {
      console.error('Failed to set duty cycle:', error);
    }
  },

  sendAdvert: async () => {
    try {
      const response = await api.sendAdvert();
      if (response.success) {
        // Trigger advert flash on successful send
        set({ flashAdvert: get().flashAdvert + 1 });
      }
      return response.success;
    } catch (error) {
      console.error('Failed to send advert:', error);
      return false;
    }
  },
  
  triggerFlashReceived: () => {
    set({ flashReceived: get().flashReceived + 1 });
  },
  
  triggerFlashAdvert: () => {
    set({ flashAdvert: get().flashAdvert + 1 });
  },

  addResourceDataPoint: (cpu: number, memory: number, maxSlots: number) => {
    const now = Date.now();
    const { lastResourceFetch, resourceHistory } = get();
    
    // Prevent duplicate entries if called multiple times rapidly
    if (now - lastResourceFetch < 1000) return;
    
    const timeStr = new Date(now).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    
    const newEntry: ResourceDataPoint = {
      timestamp: now,
      time: timeStr,
      cpu,
      memory,
    };
    
    const updated = [...resourceHistory, newEntry];
    // Keep only the most recent maxSlots entries
    const trimmed = updated.length > maxSlots ? updated.slice(-maxSlots) : updated;
    
    set({ resourceHistory: trimmed, lastResourceFetch: now });
    
    // Persist to localStorage
    saveResourceHistory(trimmed, now);
  },
}));

// Main store hook (full access)
export const useStore = store;

// Granular selectors for performance - prevents re-renders when unrelated state changes
export const useStats = () => store((s) => s.stats);
export const useStatsLoading = () => store((s) => s.statsLoading);
export const useStatsError = () => store((s) => s.statsError);
export const usePackets = () => store((s) => s.packets);
export const usePacketsLoading = () => store((s) => s.packetsLoading);
export const useLogs = () => store((s) => s.logs);
export const useLogsLoading = () => store((s) => s.logsLoading);
export const useLiveMode = () => store((s) => s.liveMode);
export const useFlashReceived = () => store((s) => s.flashReceived);
export const useFlashAdvert = () => store((s) => s.flashAdvert);

// Individual action selectors (stable references, no re-renders)
export const useFetchStats = () => store((s) => s.fetchStats);
export const useFetchPackets = () => store((s) => s.fetchPackets);
export const useFetchLogs = () => store((s) => s.fetchLogs);
export const useSetLiveMode = () => store((s) => s.setLiveMode);
export const useSetMode = () => store((s) => s.setMode);
export const useSetDutyCycle = () => store((s) => s.setDutyCycle);
export const useSendAdvert = () => store((s) => s.sendAdvert);
export const useTriggerFlashReceived = () => store((s) => s.triggerFlashReceived);
export const useTriggerFlashAdvert = () => store((s) => s.triggerFlashAdvert);
export const useResourceHistory = () => store((s) => s.resourceHistory);
export const useAddResourceDataPoint = () => store((s) => s.addResourceDataPoint);
