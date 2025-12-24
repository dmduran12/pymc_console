/**
 * RecentPackets - Dashboard widget showing latest packet activity
 * 
 * NOTE: This component does NOT poll for data. It consumes packets from the
 * centralized Zustand store, which handles polling at the App level.
 * Only visual state (flash effects, modal) is managed locally.
 */

import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { usePackets, usePacketsLoading, useLiveMode, useFlashAdvert } from '@/lib/stores/useStore';
import { Radio, Circle, ArrowRight } from 'lucide-react';
import { getPayloadTypeName } from '@/lib/packet-utils';
import { PacketRow, PacketCard } from './PacketRow';
import { PacketDetailModal } from './PacketDetailModal';
import type { Packet } from '@/types/api';

/** Max packets to display in dashboard card */
const MAX_PACKETS = 15;

export function RecentPackets() {
  // Data from centralized store (polling handled at App level)
  const packets = usePackets();
  const packetsLoading = usePacketsLoading();
  const liveMode = useLiveMode();
  const flashAdvert = useFlashAdvert();
  
  // Local UI state only
  const [flashingAdvertId, setFlashingAdvertId] = useState<string | null>(null);
  const [selectedPacket, setSelectedPacket] = useState<Packet | null>(null);
  const lastHandledFlash = useRef(0);
  
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
        // Use requestAnimationFrame to avoid synchronous setState in effect
        const raf = requestAnimationFrame(() => setFlashingAdvertId(newestAdvert.packet_hash));
        const timer = setTimeout(() => setFlashingAdvertId(null), 600);
        return () => {
          cancelAnimationFrame(raf);
          clearTimeout(timer);
        };
      }
    }
  }, [flashAdvert, packets]);

  const displayPackets = packets.slice(0, MAX_PACKETS);

  return (
    <div className="chart-container h-full flex flex-col">
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

      {/* Mobile header */}
      <div className="sm:hidden flex items-center gap-1.5 px-3 py-1.5 border-b border-border-subtle/50 bg-bg-elevated/20">
        <span className="text-[9px] font-semibold text-text-muted uppercase tracking-wider w-14 flex-shrink-0">Dir</span>
        <span className="text-[9px] font-semibold text-text-muted uppercase tracking-wider w-7 flex-shrink-0">Time</span>
        <span className="text-[9px] font-semibold text-text-muted uppercase tracking-wider w-9 flex-shrink-0">Src</span>
        <span className="text-[9px] font-semibold text-text-muted uppercase tracking-wider flex-1 min-w-0">Type</span>
        <span className="text-[9px] font-semibold text-text-muted uppercase tracking-wider w-14 flex-shrink-0">Route</span>
        <span className="text-[9px] font-semibold text-text-muted uppercase tracking-wider w-10 text-right flex-shrink-0">Signal</span>
      </div>

      {/* Desktop table */}
      <div className="hidden sm:block flex-1 overflow-hidden">
        <div className="h-full overflow-y-auto">
          <table className="w-full">
            <thead className="sticky top-0 bg-bg-elevated/95 backdrop-blur-sm">
              <tr className="border-b border-border-subtle/50">
                <th className="text-left py-1.5 px-3 text-[9px] font-semibold text-text-muted uppercase tracking-wider w-16">Dir</th>
                <th className="text-left py-1.5 px-3 text-[9px] font-semibold text-text-muted uppercase tracking-wider">Time</th>
                <th className="text-left py-1.5 px-3 text-[9px] font-semibold text-text-muted uppercase tracking-wider">Source</th>
                <th className="text-left py-1.5 px-3 text-[9px] font-semibold text-text-muted uppercase tracking-wider">Type</th>
                <th className="text-left py-1.5 px-3 text-[9px] font-semibold text-text-muted uppercase tracking-wider">Route</th>
                <th className="text-right py-1.5 px-3 pr-4 text-[9px] font-semibold text-text-muted uppercase tracking-wider">Signal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle/30">
              {packetsLoading && packets.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-text-muted">
                    Loading packets...
                  </td>
                </tr>
              ) : displayPackets.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-8">
                    <Radio className="w-6 h-6 text-text-muted mx-auto mb-2" />
                    <div className="text-sm text-text-primary">No packets received</div>
                    <div className="text-xs text-text-muted">Packets will appear here</div>
                  </td>
                </tr>
              ) : (
              displayPackets.map((packet) => {
                  const typeName = packet.payload_type_name || getPayloadTypeName(packet.payload_type ?? packet.type);
                  const isAdvert = typeName.toLowerCase().includes('advert');
                  return (
                    <PacketRow
                      key={packet.packet_hash}
                      packet={packet}
                      onClick={setSelectedPacket}
                      isFlashing={isAdvert && flashingAdvertId === packet.packet_hash}
                    />
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile list */}
      <div className="sm:hidden flex-1 overflow-y-auto divide-y divide-border-subtle/30">
        {packetsLoading && packets.length === 0 ? (
          <div className="p-8 text-center text-text-muted">
            Loading packets...
          </div>
        ) : displayPackets.length === 0 ? (
          <div className="p-8 text-center">
            <Radio className="w-6 h-6 text-text-muted mx-auto mb-2" />
            <div className="text-sm text-text-primary">No packets received</div>
            <div className="text-xs text-text-muted">Packets will appear here</div>
          </div>
        ) : (
          displayPackets.map((packet) => {
            const typeName = packet.payload_type_name || getPayloadTypeName(packet.payload_type ?? packet.type);
            const isAdvert = typeName.toLowerCase().includes('advert');
            return (
              <PacketCard
                key={packet.packet_hash}
                packet={packet}
                onClick={setSelectedPacket}
                isFlashing={isAdvert && flashingAdvertId === packet.packet_hash}
              />
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-1.5 border-t border-border-subtle/50 text-[10px] text-text-muted bg-bg-elevated/20 text-center">
        Showing {displayPackets.length} of {packets.length} packets
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
