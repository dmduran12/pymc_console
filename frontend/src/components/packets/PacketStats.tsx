import { memo, useMemo } from 'react';
import { ArrowDown, ArrowRight, XCircle, Copy, Users } from 'lucide-react';
import clsx from 'clsx';
import type { Packet } from '@/types/api';
import { getPacketDirection } from './PacketDirection';

interface PacketStatsProps {
  packets: Packet[];
}

interface StatItemProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
  percentage?: number;
}

function StatItem({ icon, label, value, color, percentage }: StatItemProps) {
  return (
    <div className="flex items-center gap-2">
      <div className={clsx('p-1.5 rounded-md', color)}>
        {icon}
      </div>
      <div className="flex flex-col">
        <span className="text-sm font-semibold text-text-primary">{value.toLocaleString()}</span>
        <span className="text-[10px] text-text-muted leading-tight">
          {label}
          {percentage !== undefined && (
            <span className="ml-1 opacity-70">({percentage}%)</span>
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * Summary statistics bar for packet list
 * Shows breakdown of packet directions and unique sources
 */
function PacketStatsComponent({ packets }: PacketStatsProps) {
  const stats = useMemo(() => {
    let rx = 0;
    let fwd = 0;
    let dropped = 0;
    let duplicate = 0;
    const sources = new Set<string>();
    let totalRssi = 0;
    let rssiCount = 0;

    for (const pkt of packets) {
      const direction = getPacketDirection(pkt);
      
      switch (direction) {
        case 'rx':
          rx++;
          break;
        case 'forward':
          fwd++;
          break;
        case 'dropped':
          dropped++;
          break;
        case 'duplicate':
          duplicate++;
          break;
      }
      
      if (pkt.src_hash) {
        sources.add(pkt.src_hash);
      }
      
      if (pkt.rssi) {
        totalRssi += pkt.rssi;
        rssiCount++;
      }
    }

    const total = packets.length;
    const avgRssi = rssiCount > 0 ? Math.round(totalRssi / rssiCount) : 0;

    return {
      total,
      rx,
      fwd,
      dropped,
      duplicate,
      uniqueSources: sources.size,
      avgRssi,
      rxPercent: total > 0 ? Math.round((rx / total) * 100) : 0,
      fwdPercent: total > 0 ? Math.round((fwd / total) * 100) : 0,
      droppedPercent: total > 0 ? Math.round((dropped / total) * 100) : 0,
    };
  }, [packets]);

  if (packets.length === 0) {
    return null;
  }

  return (
    <div className="glass-card p-3">
      {/* Mobile: 2x2 grid */}
      {/* Desktop: Single row */}
      <div className="grid grid-cols-2 gap-3 sm:flex sm:items-center sm:justify-between sm:gap-6">
        <StatItem
          icon={<ArrowDown className="w-3.5 h-3.5 text-accent-primary" />}
          label="Received"
          value={stats.rx}
          color="bg-accent-primary/10"
          percentage={stats.rxPercent}
        />
        <StatItem
          icon={<ArrowRight className="w-3.5 h-3.5 text-accent-success" />}
          label="Forwarded"
          value={stats.fwd}
          color="bg-accent-success/10"
          percentage={stats.fwdPercent}
        />
        <StatItem
          icon={<XCircle className="w-3.5 h-3.5 text-accent-danger" />}
          label="Dropped"
          value={stats.dropped}
          color="bg-accent-danger/10"
          percentage={stats.droppedPercent}
        />
        <StatItem
          icon={<Copy className="w-3.5 h-3.5 text-text-muted" />}
          label="Duplicates"
          value={stats.duplicate}
          color="bg-white/5"
        />
        
        {/* Desktop only: Additional stats */}
        <div className="hidden sm:flex items-center gap-6 ml-auto">
          <StatItem
            icon={<Users className="w-3.5 h-3.5 text-accent-secondary" />}
            label="Sources"
            value={stats.uniqueSources}
            color="bg-accent-secondary/10"
          />
          <div className="flex flex-col items-end">
            <span className="text-sm font-mono text-text-secondary">{stats.avgRssi} dBm</span>
            <span className="text-[10px] text-text-muted">Avg Signal</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export const PacketStats = memo(PacketStatsComponent);
