import { memo, useState, useCallback } from 'react';
import { X, Copy, Check, ChevronDown, ChevronRight, ArrowRight } from 'lucide-react';
import clsx from 'clsx';
import type { Packet } from '@/types/api';
import { formatTimestamp } from '@/lib/format';
import { HashBadge } from '@/components/ui/HashBadge';
import {
  getPayloadTypeName,
  getRouteTypeName,
  getPacketTypeColor,
  getRouteTypeColor,
} from '@/lib/packet-utils';
import { SignalIndicator, getSignalQualityLabel } from './SignalIndicator';
import { PacketDirection, getPacketStatusText, getPacketStatusColor } from './PacketDirection';

interface PacketDetailModalProps {
  packet: Packet;
  onClose: () => void;
}

/**
 * Parse path array from JSON string or return as-is
 */
function parsePath(path: string | string[] | undefined): string[] {
  if (!path) return [];
  if (Array.isArray(path)) return path;
  try {
    const parsed = JSON.parse(path);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Try to decode payload as ASCII text
 */
function tryDecodePayload(payload: string | undefined): { text: string | null; isText: boolean } {
  if (!payload) return { text: null, isText: false };
  
  try {
    // If it looks like hex, try to decode
    if (/^[0-9a-fA-F]+$/.test(payload)) {
      const bytes = payload.match(/.{1,2}/g)?.map(b => parseInt(b, 16)) || [];
      const decoded = String.fromCharCode(...bytes);
      // Check if it's printable ASCII
      const printable = decoded.replace(/[^\x20-\x7E]/g, '');
      if (printable.length > decoded.length * 0.7) {
        return { text: printable, isText: true };
      }
    }
    // Already text
    if (/^[\x20-\x7E\s]+$/.test(payload)) {
      return { text: payload, isText: true };
    }
  } catch {
    // Ignore decode errors
  }
  return { text: null, isText: false };
}

/**
 * Full-featured packet detail modal
 * Mobile: Full screen drawer from bottom
 * Desktop: Centered modal
 */
function PacketDetailModalComponent({ packet, onClose }: PacketDetailModalProps) {
  const [showRawHex, setShowRawHex] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const payloadTypeName =
    packet.payload_type_name || getPayloadTypeName(packet.payload_type ?? packet.type);
  const routeTypeName =
    packet.route_type_name || getRouteTypeName(packet.route_type ?? packet.route);
  const payloadLength = packet.payload_length ?? packet.length ?? 0;
  const txDelay = packet.tx_delay_ms ?? 0;
  
  const originalPath = parsePath(packet.original_path);
  const forwardedPath = parsePath(packet.forwarded_path);
  const hasPath = originalPath.length > 0 || forwardedPath.length > 0;
  
  const payloadDecoded = tryDecodePayload(packet.payload);
  const hasPayload = packet.payload && packet.payload.length > 0;
  const hasRawPacket = packet.raw_packet && packet.raw_packet.length > 0;

  const copyToClipboard = useCallback(async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      // Clipboard not available
    }
  }, []);

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      {/* Mobile: Bottom sheet / Desktop: Centered modal */}
      <div
        className={clsx(
          'glass-card w-full max-h-[90vh] overflow-hidden flex flex-col',
          'sm:max-w-xl sm:mx-4 sm:rounded-xl',
          'rounded-t-2xl rounded-b-none sm:rounded-b-xl'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border-subtle flex-shrink-0">
          <div className="flex items-center gap-3">
            <PacketDirection packet={packet} showLabel size="md" />
            <div>
              <h3 className={clsx('text-base font-semibold', getPacketTypeColor(payloadTypeName))}>
                {payloadTypeName}
              </h3>
              <p className="text-xs text-text-muted">{formatTimestamp(packet.timestamp)}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-subtle transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="overflow-y-auto flex-1 p-4 space-y-4">
          {/* Primary info grid */}
          <div className="grid grid-cols-2 gap-3">
            <InfoCard label="Packet Hash">
              <div className="flex items-center gap-2">
                <HashBadge hash={packet.packet_hash} size="sm" />
                <CopyButton
                  onClick={() => copyToClipboard(packet.packet_hash, 'hash')}
                  copied={copiedField === 'hash'}
                />
              </div>
            </InfoCard>
            <InfoCard label="Route">
              <span className={clsx('px-2 py-0.5 rounded text-xs border font-medium', getRouteTypeColor(routeTypeName))}>
                {routeTypeName}
              </span>
            </InfoCard>
          </div>

          {/* Signal quality */}
          <div className="glass-card p-3 bg-bg-elevated/50">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-text-muted mb-1">Signal Quality</p>
                <p className="text-sm font-medium text-text-primary">
                  {getSignalQualityLabel(packet.rssi)}
                </p>
              </div>
              <SignalIndicator rssi={packet.rssi} snr={packet.snr} showValues />
            </div>
          </div>

          {/* Source / Destination */}
          {(packet.src_hash || packet.dst_hash) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {packet.src_hash && (
                <InfoCard label="Source">
                  <div className="flex items-center gap-2">
                    <HashBadge hash={packet.src_hash} size="sm" />
                    <CopyButton
                      onClick={() => copyToClipboard(packet.src_hash!, 'src')}
                      copied={copiedField === 'src'}
                    />
                  </div>
                </InfoCard>
              )}
              {packet.dst_hash && (
                <InfoCard label="Destination">
                  <div className="flex items-center gap-2">
                    <HashBadge hash={packet.dst_hash} size="sm" />
                    <CopyButton
                      onClick={() => copyToClipboard(packet.dst_hash!, 'dst')}
                      copied={copiedField === 'dst'}
                    />
                  </div>
                </InfoCard>
              )}
            </div>
          )}

          {/* Path visualization */}
          {hasPath && (
            <div className="glass-card p-3 bg-bg-elevated/50">
              <p className="text-xs text-text-muted mb-2">Packet Path</p>
              <PathVisualization
                originalPath={originalPath}
                forwardedPath={forwardedPath}
              />
            </div>
          )}

          {/* Stats grid */}
          <div className="grid grid-cols-3 gap-3">
            <InfoCard label="Size" compact>
              <span className="font-mono">{payloadLength}B</span>
            </InfoCard>
            <InfoCard label="TX Delay" compact>
              <span className="font-mono">{txDelay.toFixed(1)}ms</span>
            </InfoCard>
            <InfoCard label="Score" compact>
              <span className="font-mono">
                {packet.score !== undefined ? packet.score.toFixed(3) : '—'}
              </span>
            </InfoCard>
          </div>

          {/* Status */}
          <InfoCard label="Status">
            <span className={getPacketStatusColor(packet)}>
              {getPacketStatusText(packet)}
            </span>
          </InfoCard>

          {/* Payload preview */}
          {hasPayload && (
            <div className="glass-card p-3 bg-bg-elevated/50">
              <p className="text-xs text-text-muted mb-2">Payload</p>
              {payloadDecoded.isText && payloadDecoded.text ? (
                <div className="bg-bg-base rounded p-2">
                  <p className="text-sm text-text-primary font-mono break-all">
                    {payloadDecoded.text}
                  </p>
                </div>
              ) : (
                <p className="text-xs text-text-muted font-mono break-all">
                  {packet.payload?.slice(0, 100)}
                  {packet.payload && packet.payload.length > 100 && '...'}
                </p>
              )}
            </div>
          )}

          {/* Raw hex (collapsible) */}
          {hasRawPacket && (
            <div className="glass-card bg-bg-elevated/50 overflow-hidden">
              <button
                onClick={() => setShowRawHex(!showRawHex)}
                className="w-full p-3 flex items-center justify-between text-left hover:bg-bg-subtle transition-colors"
              >
                <span className="text-xs text-text-muted">Raw Packet Hex</span>
                {showRawHex ? (
                  <ChevronDown className="w-4 h-4 text-text-muted" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-text-muted" />
                )}
              </button>
              {showRawHex && (
                <div className="px-3 pb-3">
                  <div className="bg-bg-base rounded p-2 relative">
                    <pre className="text-[10px] text-text-secondary font-mono break-all whitespace-pre-wrap">
                      {packet.raw_packet}
                    </pre>
                    <button
                      onClick={() => copyToClipboard(packet.raw_packet!, 'raw')}
                      className="absolute top-2 right-2 p-1 rounded bg-bg-elevated hover:bg-bg-subtle transition-colors"
                    >
                      {copiedField === 'raw' ? (
                        <Check className="w-3 h-3 text-accent-success" />
                      ) : (
                        <Copy className="w-3 h-3 text-text-muted" />
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Info card for displaying labeled values */
function InfoCard({
  label,
  children,
  compact = false,
}: {
  label: string;
  children: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={clsx('flex flex-col', compact ? 'gap-0.5' : 'gap-1')}>
      <span className="text-[10px] text-text-muted uppercase tracking-wide">{label}</span>
      <span className={clsx('text-text-primary', compact ? 'text-xs' : 'text-sm')}>
        {children}
      </span>
    </div>
  );
}

/** Copy button with feedback */
function CopyButton({ onClick, copied }: { onClick: () => void; copied: boolean }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="p-1 rounded hover:bg-bg-subtle transition-colors"
    >
      {copied ? (
        <Check className="w-3 h-3 text-accent-success" />
      ) : (
        <Copy className="w-3 h-3 text-text-muted" />
      )}
    </button>
  );
}

/** Path visualization showing packet route */
function PathVisualization({
  originalPath,
  forwardedPath,
}: {
  originalPath: string[];
  forwardedPath: string[];
}) {
  const path = forwardedPath.length > 0 ? forwardedPath : originalPath;
  
  if (path.length === 0) {
    return <span className="text-xs text-text-muted">No path data</span>;
  }

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {path.map((hop, i) => (
        <div key={i} className="flex items-center gap-1">
          <HashBadge hash={hop} size="xs" />
          {i < path.length - 1 && (
            <ArrowRight className="w-3 h-3 text-text-muted flex-shrink-0" />
          )}
        </div>
      ))}
    </div>
  );
}

export const PacketDetailModal = memo(PacketDetailModalComponent);
