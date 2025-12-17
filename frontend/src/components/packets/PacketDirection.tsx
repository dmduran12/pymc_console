import { memo } from 'react';
import { ArrowDown, ArrowUp, ArrowRight, CornerDownRight } from 'lucide-react';
import clsx from 'clsx';
import type { Packet } from '@/types/api';

type PacketDirectionType = 'rx' | 'tx' | 'forward' | 'dropped' | 'duplicate';

interface PacketDirectionProps {
  packet: Packet;
  /** Show label text next to icon */
  showLabel?: boolean;
  /** Size variant */
  size?: 'sm' | 'md';
}

/**
 * Determine packet direction/status from packet data
 */
export function getPacketDirection(packet: Packet): PacketDirectionType {
  // Check packet_origin first (most reliable)
  if (packet.packet_origin === 'tx_local') return 'tx';
  if (packet.packet_origin === 'tx_forward') return 'forward';
  
  // Fallback to field checks
  if (packet.is_duplicate) return 'duplicate';
  if (packet.transmitted) return 'forward';
  if (packet.drop_reason) return 'dropped';
  
  return 'rx';
}

const directionConfig: Record<PacketDirectionType, {
  icon: typeof ArrowDown;
  label: string;
  color: string;
  bgColor: string;
}> = {
  rx: {
    icon: ArrowDown,
    label: 'RX',
    color: 'text-accent-primary',
    bgColor: 'bg-accent-primary/10',
  },
  tx: {
    icon: ArrowUp,
    label: 'TX',
    color: 'text-[#F9D26F]',
    bgColor: 'bg-[#F9D26F]/10',
  },
  forward: {
    icon: ArrowRight,
    label: 'FWD',
    color: 'text-accent-success',
    bgColor: 'bg-accent-success/10',
  },
  dropped: {
    icon: CornerDownRight,
    label: 'DROP',
    color: 'text-accent-danger',
    bgColor: 'bg-accent-danger/10',
  },
  duplicate: {
    icon: ArrowDown,
    label: 'DUP',
    color: 'text-text-muted',
    bgColor: 'bg-white/5',
  },
};

/**
 * Visual indicator for packet direction (RX/TX/FWD)
 */
function PacketDirectionComponent({ packet, showLabel = true, size = 'sm' }: PacketDirectionProps) {
  const direction = getPacketDirection(packet);
  const config = directionConfig[direction];
  const Icon = config.icon;

  const sizeClasses = {
    sm: 'w-3.5 h-3.5',
    md: 'w-4 h-4',
  };

  return (
    <div
      className={clsx(
        'inline-flex items-center gap-1 rounded-md',
        showLabel && 'px-1.5 py-0.5',
        showLabel && config.bgColor
      )}
    >
      <Icon className={clsx(sizeClasses[size], config.color)} />
      {showLabel && (
        <span className={clsx('text-[10px] font-semibold tracking-wide', config.color)}>
          {config.label}
        </span>
      )}
    </div>
  );
}

export const PacketDirection = memo(PacketDirectionComponent);

/**
 * Get status text for display
 */
export function getPacketStatusText(packet: Packet): string {
  if (packet.packet_origin === 'tx_local') return 'Transmitted';
  if (packet.packet_origin === 'tx_forward' || packet.transmitted) return 'Forwarded';
  if (packet.is_duplicate) return 'Duplicate';
  if (packet.drop_reason === 'No transport keys configured') return 'Monitor Only';
  if (packet.drop_reason) return packet.drop_reason;
  return 'Received';
}

/**
 * Get status color class
 */
export function getPacketStatusColor(packet: Packet): string {
  const direction = getPacketDirection(packet);
  return directionConfig[direction].color;
}
