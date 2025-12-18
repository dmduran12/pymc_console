import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { usePackets, usePacketsLoading, useLiveMode, useFetchPackets, useFlashAdvert } from '@/lib/stores/useStore';
import { usePolling } from '@/lib/hooks/usePolling';
import { Radio, Circle, ArrowRight } from 'lucide-react';
import { POLLING_INTERVALS } from '@/lib/constants';
import { getPayloadTypeName } from '@/lib/packet-utils';
import { PacketListItem } from './PacketRow';

export function RecentPackets() {
  const packets = usePackets();
  const packetsLoading = usePacketsLoading();
  const liveMode = useLiveMode();
  const fetchPackets = useFetchPackets();
  const flashAdvert = useFlashAdvert();
  const [flashingAdvertId, setFlashingAdvertId] = useState<string | null>(null);
  const lastHandledFlash = useRef(0);

  // Poll packets when in live mode
  usePolling(
    () => fetchPackets(20),
    POLLING_INTERVALS.packets,
    liveMode
  );
  
  // Detect new advert packets when flashAdvert changes (only trigger once per flash)
  useEffect(() => {
    // Only trigger if this is a new flash we haven't handled
    if (flashAdvert > 0 && flashAdvert !== lastHandledFlash.current && packets.length > 0) {
      lastHandledFlash.current = flashAdvert;
      // Find the newest advert packet
      const newestAdvert = packets.find(p => {
        const typeName = p.payload_type_name || getPayloadTypeName(p.payload_type ?? p.type);
        return typeName.toLowerCase().includes('advert');
      });
      if (newestAdvert) {
        const id = String(newestAdvert.id ?? newestAdvert.packet_hash ?? '');
        // Use requestAnimationFrame to avoid synchronous setState in effect
        const raf = requestAnimationFrame(() => setFlashingAdvertId(id));
        const timer = setTimeout(() => setFlashingAdvertId(null), 600);
        return () => {
          cancelAnimationFrame(raf);
          clearTimeout(timer);
        };
      }
    }
  }, [flashAdvert, packets]);

  return (
    <div className="chart-container h-full">
      <div className="chart-header">
        <div className="chart-title">
          <Radio className="chart-title-icon" />
          Recent Packets
        </div>
        <div className="flex items-center gap-3">
          {liveMode && (
            <div className="flex items-center gap-2">
              <Circle className="w-2 h-2 fill-accent-success text-accent-success animate-pulse" />
              <span className="type-data-xs text-text-muted">LIVE</span>
            </div>
          )}
          <Link 
            to="/packets"
            className="pill-subtle"
          >
            View all <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      </div>

      {/* Column headers */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border-subtle/50 bg-bg-elevated/20">
        <span className="text-[9px] font-semibold text-text-muted uppercase tracking-wider w-14 flex-shrink-0">Dir</span>
        <span className="text-[9px] font-semibold text-text-muted uppercase tracking-wider w-7 flex-shrink-0">Time</span>
        <span className="text-[9px] font-semibold text-text-muted uppercase tracking-wider w-9 flex-shrink-0">Src</span>
        <span className="text-[9px] font-semibold text-text-muted uppercase tracking-wider flex-1 min-w-0">Type</span>
        <span className="text-[9px] font-semibold text-text-muted uppercase tracking-wider w-14 flex-shrink-0">Route</span>
        <span className="text-[9px] font-semibold text-text-muted uppercase tracking-wider w-10 text-right flex-shrink-0">Signal</span>
      </div>

      {/* Packet list */}
      <div className="max-h-[360px] overflow-y-auto divide-y divide-border-subtle/30">
        {packetsLoading && packets.length === 0 ? (
          <div className="p-8 text-center text-text-muted">
            Loading packets...
          </div>
        ) : packets.length === 0 ? (
          <div className="p-8 text-center">
            <Radio className="w-8 h-8 text-text-muted mx-auto mb-2" />
            <div className="text-sm text-text-primary">No packets received</div>
            <div className="text-xs text-text-muted">Packets will appear here as they are received</div>
          </div>
        ) : (
          packets.slice(0, 15).map((packet, index) => {
            const packetId = String(packet.id ?? packet.packet_hash ?? index);
            const typeName = packet.payload_type_name || getPayloadTypeName(packet.payload_type ?? packet.type);
            const isAdvert = typeName.toLowerCase().includes('advert');
            return (
              <PacketListItem
                key={packetId}
                packet={packet}
                isFlashing={isAdvert && flashingAdvertId === packetId}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
