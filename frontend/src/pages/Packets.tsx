import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Radio, Filter, RefreshCw, Circle, X } from 'lucide-react';
import clsx from 'clsx';
import { getRecentPackets } from '@/lib/api';
import type { Packet, PacketFilters } from '@/types/api';
import { PAYLOAD_TYPES, ROUTE_TYPES } from '@/types/api';
import { usePolling } from '@/lib/hooks/usePolling';
import { POLLING_INTERVALS } from '@/lib/constants';
import { getPayloadTypeName } from '@/lib/packet-utils';
import { useFlashAdvert } from '@/lib/stores/useStore';
import { PacketRow, PacketCard } from '@/components/packets/PacketRow';
import { PacketDetailModal } from '@/components/packets/PacketDetailModal';
import { PacketStats } from '@/components/packets/PacketStats';
import { getPacketDirection } from '@/components/packets/PacketDirection';

/** Extended filters including status, signal, and time range */
interface ExtendedFilters extends PacketFilters {
  status?: 'all' | 'rx' | 'forward' | 'dropped' | 'duplicate';
  signalMin?: number; // Minimum RSSI threshold
  timeRange?: number; // Hours (0 = all)
}

export default function Packets() {
  const [packets, setPackets] = useState<Packet[]>([]);
  const [loading, setLoading] = useState(true);
  const [liveMode, setLiveMode] = useState(true);
  const [selectedPacket, setSelectedPacket] = useState<Packet | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<ExtendedFilters>({
    limit: 100,
    status: 'all',
  });
  const flashAdvert = useFlashAdvert();
  const [flashingAdvertId, setFlashingAdvertId] = useState<string | null>(null);
  const lastHandledFlash = useRef(0);

  const fetchPackets = useCallback(async () => {
    try {
      const response = await getRecentPackets(filters.limit || 100);
      
      if (response.success && response.data) {
        setPackets(response.data);
      }
    } catch {
      // Silently fail - UI shows stale data
    } finally {
      setLoading(false);
    }
  }, [filters.limit]);

  // Apply client-side filtering
  const filteredPackets = useMemo(() => {
    let result = packets;
    
    // Type filter
    if (filters.type !== undefined) {
      const filterTypeName = PAYLOAD_TYPES[filters.type];
      result = result.filter((p) => {
        const packetTypeNum = p.type ?? p.payload_type;
        const packetTypeName = p.payload_type_name;
        return packetTypeNum === filters.type || packetTypeName === filterTypeName;
      });
    }
    
    // Route filter
    if (filters.route !== undefined) {
      const filterRouteName = ROUTE_TYPES[filters.route];
      result = result.filter((p) => {
        const packetRouteNum = p.route ?? p.route_type;
        const packetRouteName = p.route_type_name;
        return packetRouteNum === filters.route || packetRouteName === filterRouteName;
      });
    }
    
    // Status filter
    if (filters.status && filters.status !== 'all') {
      result = result.filter((p) => getPacketDirection(p) === filters.status);
    }
    
    // Signal strength filter
    if (filters.signalMin !== undefined) {
      result = result.filter((p) => p.rssi >= filters.signalMin!);
    }
    
    // Time range filter
    if (filters.timeRange && filters.timeRange > 0) {
      const cutoff = Date.now() / 1000 - (filters.timeRange * 3600);
      result = result.filter((p) => p.timestamp >= cutoff);
    }
    
    return result;
  }, [packets, filters.type, filters.route, filters.status, filters.signalMin, filters.timeRange]);

  // Fetch immediately when limit changes
  useEffect(() => {
    fetchPackets();
  }, [fetchPackets]);

  // Set up polling for live mode
  usePolling(fetchPackets, POLLING_INTERVALS.packets, liveMode, true);
  
  // Detect new advert packets
  useEffect(() => {
    if (flashAdvert > 0 && flashAdvert !== lastHandledFlash.current && packets.length > 0) {
      lastHandledFlash.current = flashAdvert;
      const newestAdvert = packets.find(p => {
        const typeName = p.payload_type_name || getPayloadTypeName(p.payload_type ?? p.type);
        return typeName.toLowerCase().includes('advert');
      });
      if (newestAdvert) {
        const id = String(newestAdvert.id ?? newestAdvert.packet_hash ?? '');
        const raf = requestAnimationFrame(() => setFlashingAdvertId(id));
        const timer = setTimeout(() => setFlashingAdvertId(null), 600);
        return () => {
          cancelAnimationFrame(raf);
          clearTimeout(timer);
        };
      }
    }
  }, [flashAdvert, packets]);

  const handleFilterChange = <K extends keyof ExtendedFilters>(key: K, value: ExtendedFilters[K]) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  };

  const clearFilters = () => {
    setFilters({ limit: filters.limit, status: 'all' });
  };

  const hasActiveFilters = 
    filters.type !== undefined || 
    filters.route !== undefined || 
    (filters.status && filters.status !== 'all') ||
    filters.signalMin !== undefined ||
    (filters.timeRange && filters.timeRange > 0);

  return (
    <div className="section-gap">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="type-title text-text-primary flex items-center gap-3">
          <Radio className="w-6 h-6 text-accent-primary flex-shrink-0" />
          Packet History
        </h1>
        <div className="flex items-center gap-2 sm:gap-3">
          {liveMode && (
            <div className="flex items-center gap-1.5 text-xs">
              <Circle className="w-1.5 h-1.5 fill-accent-success text-accent-success animate-pulse" />
              <span className="text-text-muted hidden xs:inline">Live</span>
            </div>
          )}
          {/* Mobile filter toggle */}
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={clsx(
              'sm:hidden px-3 py-1.5 rounded-lg text-sm font-medium transition-all',
              'flex items-center gap-1.5 border',
              hasActiveFilters
                ? 'bg-accent-primary/20 text-accent-primary border-accent-primary/30'
                : 'bg-bg-subtle text-text-muted border-border-subtle'
            )}
          >
            <Filter className="w-4 h-4" />
            {hasActiveFilters && <span className="w-1.5 h-1.5 rounded-full bg-accent-primary" />}
          </button>
          <button
            onClick={() => setLiveMode(!liveMode)}
            className={clsx(
              'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200',
              'flex items-center gap-1.5 border',
              liveMode
                ? 'bg-accent-success/20 text-accent-success border-accent-success/30'
                : 'bg-bg-subtle text-text-muted border-border-subtle hover:bg-bg-elevated'
            )}
          >
            <RefreshCw className={clsx('w-4 h-4', liveMode && 'animate-spin')} />
            <span className="hidden xs:inline">{liveMode ? 'Live' : 'Paused'}</span>
          </button>
        </div>
      </div>

      {/* Filters - Always visible on desktop, collapsible on mobile */}
      <div className={clsx(
        'glass-card overflow-hidden transition-all duration-200',
        showFilters ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0 sm:max-h-96 sm:opacity-100'
      )}>
        <div className="p-3 sm:p-4">
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-accent-primary" />
              <span className="text-sm text-text-primary font-medium">Filters</span>
            </div>
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="text-xs text-text-muted hover:text-text-primary flex items-center gap-1"
              >
                <X className="w-3 h-3" /> Clear
              </button>
            )}
          </div>
          
          {/* Filter grid - responsive */}
          <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-3">
            {/* Type filter */}
            <div className="flex-1 min-w-[120px]">
              <label className="block text-[10px] text-text-muted mb-1 uppercase tracking-wide">Type</label>
              <select
                value={filters.type ?? ''}
                onChange={(e) => handleFilterChange('type', e.target.value ? Number(e.target.value) : undefined)}
                className="w-full bg-bg-subtle border border-border-subtle rounded-lg px-2.5 py-1.5 text-sm text-text-primary focus:outline-none focus:border-accent-primary/50"
              >
                <option value="">All Types</option>
                {Object.entries(PAYLOAD_TYPES).map(([value, name]) => (
                  <option key={value} value={value}>{name}</option>
                ))}
              </select>
            </div>

            {/* Route filter */}
            <div className="flex-1 min-w-[120px]">
              <label className="block text-[10px] text-text-muted mb-1 uppercase tracking-wide">Route</label>
              <select
                value={filters.route ?? ''}
                onChange={(e) => handleFilterChange('route', e.target.value ? Number(e.target.value) : undefined)}
                className="w-full bg-bg-subtle border border-border-subtle rounded-lg px-2.5 py-1.5 text-sm text-text-primary focus:outline-none focus:border-accent-primary/50"
              >
                <option value="">All Routes</option>
                {Object.entries(ROUTE_TYPES).map(([value, name]) => (
                  <option key={value} value={value}>{name}</option>
                ))}
              </select>
            </div>

            {/* Status filter */}
            <div className="flex-1 min-w-[120px]">
              <label className="block text-[10px] text-text-muted mb-1 uppercase tracking-wide">Status</label>
              <select
                value={filters.status ?? 'all'}
                onChange={(e) => handleFilterChange('status', e.target.value as ExtendedFilters['status'])}
                className="w-full bg-bg-subtle border border-border-subtle rounded-lg px-2.5 py-1.5 text-sm text-text-primary focus:outline-none focus:border-accent-primary/50"
              >
                <option value="all">All Status</option>
                <option value="rx">Received</option>
                <option value="forward">Forwarded</option>
                <option value="dropped">Dropped</option>
                <option value="duplicate">Duplicate</option>
              </select>
            </div>

            {/* Time Range */}
            <div className="flex-1 min-w-[100px]">
              <label className="block text-[10px] text-text-muted mb-1 uppercase tracking-wide">Time</label>
              <select
                value={filters.timeRange ?? 0}
                onChange={(e) => handleFilterChange('timeRange', Number(e.target.value) || undefined)}
                className="w-full bg-bg-subtle border border-border-subtle rounded-lg px-2.5 py-1.5 text-sm text-text-primary focus:outline-none focus:border-accent-primary/50"
              >
                <option value={0}>All Time</option>
                <option value={1}>Last 1h</option>
                <option value={6}>Last 6h</option>
                <option value={24}>Last 24h</option>
                <option value={168}>Last 7d</option>
              </select>
            </div>

            {/* Signal Threshold */}
            <div className="flex-1 min-w-[100px]">
              <label className="block text-[10px] text-text-muted mb-1 uppercase tracking-wide">Signal</label>
              <select
                value={filters.signalMin ?? ''}
                onChange={(e) => handleFilterChange('signalMin', e.target.value ? Number(e.target.value) : undefined)}
                className="w-full bg-bg-subtle border border-border-subtle rounded-lg px-2.5 py-1.5 text-sm text-text-primary focus:outline-none focus:border-accent-primary/50"
              >
                <option value="">Any Signal</option>
                <option value={-90}>Strong (≥-90)</option>
                <option value={-100}>Good (≥-100)</option>
                <option value={-110}>Fair (≥-110)</option>
                <option value={-120}>Weak (≥-120)</option>
              </select>
            </div>

            {/* Limit */}
            <div className="flex-1 min-w-[80px]">
              <label className="block text-[10px] text-text-muted mb-1 uppercase tracking-wide">Limit</label>
              <select
                value={filters.limit ?? 100}
                onChange={(e) => handleFilterChange('limit', Number(e.target.value))}
                className="w-full bg-bg-subtle border border-border-subtle rounded-lg px-2.5 py-1.5 text-sm text-text-primary focus:outline-none focus:border-accent-primary/50"
              >
                <option value={50}>50</option>
                <option value={100}>100</option>
                <option value={200}>200</option>
                <option value={500}>500</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Stats Summary */}
      <PacketStats packets={filteredPackets} />

      {/* Mobile: Card list */}
      <div className="sm:hidden space-y-2">
        {loading && packets.length === 0 ? (
          <div className="glass-card p-8 text-center text-text-muted">
            Loading packets...
          </div>
        ) : filteredPackets.length === 0 ? (
          <div className="glass-card p-8 text-center text-text-muted">
            No packets found
          </div>
        ) : (
          filteredPackets.map((packet, index) => {
            const packetId = String(packet.id ?? packet.packet_hash ?? index);
            const typeName = packet.payload_type_name || getPayloadTypeName(packet.payload_type ?? packet.type);
            const isAdvert = typeName.toLowerCase().includes('advert');
            return (
              <PacketCard
                key={packetId}
                packet={packet}
                onClick={setSelectedPacket}
                isFlashing={isAdvert && flashingAdvertId === packetId}
              />
            );
          })
        )}
        <div className="text-center text-xs text-text-muted py-2">
          Showing {filteredPackets.length} of {packets.length} packets
        </div>
      </div>

      {/* Desktop: Table */}
      <div className="hidden sm:block glass-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border-subtle bg-bg-elevated/30">
                <th className="text-left py-2.5 px-3 text-[10px] font-semibold text-text-muted uppercase tracking-wider w-16">Dir</th>
                <th className="text-left py-2.5 px-3 text-[10px] font-semibold text-text-muted uppercase tracking-wider">Time</th>
                <th className="text-left py-2.5 px-3 text-[10px] font-semibold text-text-muted uppercase tracking-wider">Type</th>
                <th className="text-left py-2.5 px-3 text-[10px] font-semibold text-text-muted uppercase tracking-wider">Route</th>
                <th className="text-left py-2.5 px-3 text-[10px] font-semibold text-text-muted uppercase tracking-wider">Source</th>
                <th className="text-left py-2.5 px-3 text-[10px] font-semibold text-text-muted uppercase tracking-wider">Signal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle/30">
              {loading && packets.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-12 text-text-muted">
                    Loading packets...
                  </td>
                </tr>
              ) : filteredPackets.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-12 text-text-muted">
                    No packets found
                  </td>
                </tr>
              ) : (
                filteredPackets.map((packet, index) => {
                  const packetId = String(packet.id ?? packet.packet_hash ?? index);
                  const typeName = packet.payload_type_name || getPayloadTypeName(packet.payload_type ?? packet.type);
                  const isAdvert = typeName.toLowerCase().includes('advert');
                  return (
                    <PacketRow
                      key={packetId}
                      packet={packet}
                      onClick={setSelectedPacket}
                      isFlashing={isAdvert && flashingAdvertId === packetId}
                    />
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="px-3 py-2.5 border-t border-border-subtle text-xs text-text-muted bg-bg-elevated/20">
          Showing {filteredPackets.length} of {packets.length} packets
        </div>
      </div>

      {/* Packet Detail Modal */}
      {selectedPacket && (
        <PacketDetailModal
          packet={selectedPacket}
          onClose={() => setSelectedPacket(null)}
        />
      )}
    </div>
  );
}
