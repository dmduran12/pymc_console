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
  const payloadLength = packet.payload_length ?? packet.length ?? 0;

  return (
    <tr
      onClick={() => onClick(packet)}
      className={clsx(
        'cursor-pointer transition-colors duration-150',
        'hover:bg-bg-subtle',
        isTruthy(packet.transmitted) && 'bg-accent-success/5',
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
      {/* Signal */}
      <td className="py-2.5 px-3">
        <SignalIndicator rssi={packet.rssi} snr={packet.snr} compact showValues />
      </td>
      {/* Length */}
      <td className="py-2.5 px-3 text-xs font-mono text-text-secondary">
        {payloadLength}B
      </td>
    </tr>
  );
}

/**
 * Mobile card component
 * Compact card layout optimized for touch interaction
 */
function PacketCardRow({ packet, onClick, isFlashing = false }: PacketRowProps) {
  const payloadTypeName =
    packet.payload_type_name || getPayloadTypeName(packet.payload_type ?? packet.type);
  const routeTypeName =
    packet.route_type_name || getRouteTypeName(packet.route_type ?? packet.route);
  const payloadLength = packet.payload_length ?? packet.length ?? 0;

  return (
    <div
      onClick={() => onClick(packet)}
      className={clsx(
        'p-3 rounded-lg cursor-pointer transition-all duration-150',
        'bg-bg-elevated/50 border border-border-subtle/50',
        'hover:bg-bg-subtle hover:border-border-subtle',
        'active:scale-[0.99]',
        isTruthy(packet.transmitted) && 'border-l-2 border-l-accent-success',
        isTruthy(packet.is_duplicate) && 'opacity-50',
        isFlashing && 'flash-row'
      )}
    >
      {/* Top row: Direction, Type, Time */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <PacketDirection packet={packet} showLabel={true} />
          <span className={clsx('text-sm font-semibold truncate', getPacketTypeColor(payloadTypeName))}>
            {payloadTypeName}
          </span>
          <span className={clsx('px-1.5 py-0.5 rounded text-[10px] border font-medium flex-shrink-0', getRouteTypeColor(routeTypeName))}>
            {routeTypeName}
          </span>
        </div>
        <span className="text-[10px] font-mono text-text-muted flex-shrink-0">
          {formatTimeAgo(packet.timestamp)}
        </span>
      </div>
      
      {/* Bottom row: Source, Signal, Size */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {packet.src_hash ? (
            <HashBadge hash={packet.src_hash} size="xs" />
          ) : (
            <span className="text-xs text-text-muted">Unknown source</span>
          )}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <SignalIndicator rssi={packet.rssi} compact showValues />
          <span className="text-xs font-mono text-text-muted">{payloadLength}B</span>
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
