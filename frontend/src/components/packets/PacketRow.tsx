import { memo } from 'react';
import clsx from 'clsx';
import type { Packet } from '@/types/api';
import { formatDateTime, formatTimeAgo } from '@/lib/format';
import {
  getPayloadTypeName,
  getRouteTypeName,
  getPacketTypeColor,
  getRouteTypeColor,
  isTruthy,
} from '@/lib/packet-utils';
import { SignalIndicator } from './SignalIndicator';
import { PacketDirection } from './PacketDirection';
import { HashBadge } from '@/components/ui/HashBadge';

interface PacketRowProps {
  packet: Packet;
  onClick: (packet: Packet) => void;
  isFlashing?: boolean;
}

/**
 * Desktop table row component
 * Shows full details in columnar format
 */
function PacketTableRow({ packet, onClick, isFlashing = false }: PacketRowProps) {
  const payloadTypeName =
    packet.payload_type_name || getPayloadTypeName(packet.payload_type ?? packet.type);
  const routeTypeName =
    packet.route_type_name || getRouteTypeName(packet.route_type ?? packet.route);

  return (
    <tr
      onClick={() => onClick(packet)}
      className={clsx(
        'cursor-pointer transition-colors duration-150',
        'hover:bg-bg-subtle',
        isTruthy(packet.is_duplicate) && 'opacity-50',
        isFlashing && 'flash-row'
      )}
    >
      {/* Direction */}
      <td className="py-2.5 px-3">
        <PacketDirection packet={packet} showLabel={true} />
      </td>
      {/* Time */}
      <td className="py-2.5 px-3 text-xs font-mono text-text-secondary whitespace-nowrap">
        {formatDateTime(packet.timestamp)}
      </td>
      {/* Type */}
      <td className="py-2.5 px-3">
        <span className={clsx('text-xs font-semibold', getPacketTypeColor(payloadTypeName))}>
          {payloadTypeName}
        </span>
      </td>
      {/* Route */}
      <td className="py-2.5 px-3">
        <span className={clsx('px-1.5 py-0.5 rounded text-[10px] border font-medium', getRouteTypeColor(routeTypeName))}>
          {routeTypeName}
        </span>
      </td>
      {/* Source */}
      <td className="py-2.5 px-3">
        {packet.src_hash ? (
          <HashBadge hash={packet.src_hash} size="xs" />
        ) : (
          <span className="text-xs text-text-muted">—</span>
        )}
      </td>
      {/* Signal - rightmost, right-aligned */}
      <td className="py-2.5 px-3 pr-4 text-right">
        <SignalIndicator rssi={packet.rssi} snr={packet.snr} compact showValues />
      </td>
    </tr>
  );
}

/**
 * Mobile card component
 * Ultra-compact single-row layout optimized for mobile
 */
function PacketCardRow({ packet, onClick, isFlashing = false }: PacketRowProps) {
  const payloadTypeName =
    packet.payload_type_name || getPayloadTypeName(packet.payload_type ?? packet.type);
  const routeTypeName =
    packet.route_type_name || getRouteTypeName(packet.route_type ?? packet.route);

  return (
    <div
      onClick={() => onClick(packet)}
      className={clsx(
        'px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-150',
        'bg-bg-elevated/50 border border-border-subtle/50',
        'hover:bg-bg-subtle hover:border-border-subtle',
        'active:scale-[0.99]',
        isTruthy(packet.is_duplicate) && 'opacity-50',
        isFlashing && 'flash-row'
      )}
    >
      {/* Single row: Direction | Time | Source | Type+Route | Signal */}
      <div className="flex items-center gap-2">
        {/* Direction with label (same as desktop) */}
        <PacketDirection packet={packet} showLabel={true} size="sm" />
        
        {/* Time - same position as desktop */}
        <span className="text-[10px] font-mono text-text-muted w-8 flex-shrink-0">
          {formatTimeAgo(packet.timestamp)}
        </span>
        
        {/* Source hash */}
        {packet.src_hash ? (
          <HashBadge hash={packet.src_hash} size="xs" />
        ) : (
          <span className="text-[10px] text-text-muted w-10">—</span>
        )}
        
        {/* Type & Route - takes remaining space */}
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className={clsx('text-xs font-semibold truncate', getPacketTypeColor(payloadTypeName))}>
            {payloadTypeName}
          </span>
          <span className={clsx('px-1 py-0.5 rounded text-[9px] border font-medium flex-shrink-0', getRouteTypeColor(routeTypeName))}>
            {routeTypeName}
          </span>
        </div>
        
        {/* Signal - rightmost (same as desktop) */}
        <div className="flex-shrink-0">
          <SignalIndicator rssi={packet.rssi} compact showValues />
        </div>
      </div>
    </div>
  );
}

/**
 * Responsive packet row component
 * Renders as table row on desktop, card on mobile
 */
function PacketRowComponent(props: PacketRowProps) {
  return (
    <>
      {/* Desktop: Table row (hidden on mobile) */}
      <PacketTableRow {...props} />
    </>
  );
}

export const PacketRow = memo(PacketRowComponent);
export const PacketCard = memo(PacketCardRow);
