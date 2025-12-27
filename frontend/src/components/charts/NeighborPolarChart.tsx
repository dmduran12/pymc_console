

import { memo, useMemo, useState, useEffect, useRef } from 'react';
import { Compass } from 'lucide-react';
import type { NeighborInfo } from '@/types/api';

// Pulse interval in ms
const PULSE_INTERVAL = 10000;
// Pulse animation duration in ms  
const PULSE_DURATION = 2000;
// Local node ping duration (50% of pulse)
const LOCAL_PING_DURATION = PULSE_DURATION / 2;
// Blink duration in ms
const BLINK_DURATION = 600;
// Colors
const LOCAL_NODE_COLOR = '#60A5FA';
const LOCAL_NODE_PING_COLOR = '#4CFFB5'; // Bright teal

interface NeighborPolarChartProps {
  neighbors: Record<string, NeighborInfo>;
  localLat: number;
  localLon: number;
}

// Compass direction labels
const DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

// Calculate bearing from local node to neighbor (degrees, 0 = North, clockwise)
function calculateBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;

  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);

  let bearing = (Math.atan2(y, x) * 180) / Math.PI;
  bearing = (bearing + 360) % 360;
  return bearing;
}

// Calculate distance between two points in km (Haversine formula)
function getDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Get SNR-based color with finer gradient steps
// Range: +12 dB (excellent) to -12 dB (critical)
// Colors: Green -> YellowGreen -> Yellow -> Orange -> Amber -> Red -> Deep Red
function getSnrColor(snr: number): string {
  if (snr >= 10) return '#4CFFB5';  // Excellent - bright teal/green
  if (snr >= 7) return '#39D98A';   // Very good - green
  if (snr >= 4) return '#7DD87D';   // Good - yellow-green
  if (snr >= 1) return '#A3E635';   // Fair+ - lime
  if (snr >= -2) return '#F9D26F';  // Fair - yellow/gold
  if (snr >= -5) return '#FBBF24';  // Fair- - amber
  if (snr >= -8) return '#FF8A5C';  // Poor - orange
  if (snr >= -11) return '#EF4444'; // Bad - red
  return '#B91C1C';                 // Critical - deep red
}

// Get SNR quality label with finer gradations
function getSnrQuality(snr: number): string {
  if (snr >= 10) return 'Excellent';
  if (snr >= 7) return 'Very Good';
  if (snr >= 4) return 'Good';
  if (snr >= 1) return 'Fair+';
  if (snr >= -2) return 'Fair';
  if (snr >= -5) return 'Fair-';
  if (snr >= -8) return 'Poor';
  if (snr >= -11) return 'Bad';
  return 'Critical';
}

interface ProcessedNeighbor {
  hash: string;
  name: string;
  snr: number;
  rssi: number;
  bearing: number;   // degrees from north
  distance: number;  // km
  // Polar coordinates for SVG (0-1 normalized)
  normalizedDistance: number;
  lastSeen: number;  // timestamp for blink detection
}

/**
 * Radar/compass chart showing neighbors at their actual bearing and proportional distance
 * Center = local node, edge = farthest neighbor
 * Each dot is colored by SNR quality
 */
function NeighborPolarChartComponent({
  neighbors,
  localLat,
  localLon,
}: NeighborPolarChartProps) {
  const [hoveredNeighbor, setHoveredNeighbor] = useState<ProcessedNeighbor | null>(null);
  const [blinkingHashes, setBlinkingHashes] = useState<Set<string>>(new Set());
  const [pulseKey, setPulseKey] = useState(0);
  const prevLastSeenRef = useRef<Record<string, number>>({});
  
  // Radar pulse effect - trigger immediately on mount, then every PULSE_INTERVAL
  useEffect(() => {
    // Trigger first pulse after a short delay (let component render first)
    const initialTimeout = setTimeout(() => {
      setPulseKey(1);
    }, 100);
    
    // Then continue pulsing every interval
    const interval = setInterval(() => {
      setPulseKey(k => k + 1);
    }, PULSE_INTERVAL);
    
    return () => {
      clearTimeout(initialTimeout);
      clearInterval(interval);
    };
  }, []);
  
  // Process neighbors into polar coordinates
  const { processedNeighbors, maxDistance, totalNeighbors } = useMemo(() => {
    const processed: ProcessedNeighbor[] = [];
    let maxDist = 0;

    for (const [hash, neighbor] of Object.entries(neighbors)) {
      // Skip neighbors without valid location
      if (!neighbor.latitude || !neighbor.longitude || 
          neighbor.latitude === 0 || neighbor.longitude === 0) {
        continue;
      }

      const bearing = calculateBearing(localLat, localLon, neighbor.latitude, neighbor.longitude);
      const distance = getDistanceKm(localLat, localLon, neighbor.latitude, neighbor.longitude);
      
      if (distance > maxDist) maxDist = distance;

      processed.push({
        hash: hash.slice(0, 8),
        name: neighbor.node_name || neighbor.name || 'Unknown',
        snr: neighbor.snr ?? 0,
        rssi: neighbor.rssi ?? 0,
        bearing,
        distance,
        normalizedDistance: 0, // Will be set after we know maxDistance
        lastSeen: neighbor.last_seen,
      });
    }

    // Normalize distances (0 = center, 1 = edge)
    // Use a minimum radius so close nodes aren't right at center
    const minRadius = 0.15;
    for (const n of processed) {
      n.normalizedDistance = maxDist > 0 
        ? minRadius + (n.distance / maxDist) * (1 - minRadius)
        : minRadius;
    }

    return { processedNeighbors: processed, maxDistance: maxDist, totalNeighbors: processed.length };
  }, [neighbors, localLat, localLon]);
  
  // Detect changes in last_seen to trigger blink
  useEffect(() => {
    const newBlinks: string[] = [];
    
    for (const neighbor of processedNeighbors) {
      const prevLastSeen = prevLastSeenRef.current[neighbor.hash];
      if (prevLastSeen !== undefined && prevLastSeen !== neighbor.lastSeen) {
        // This neighbor has new data - trigger blink
        newBlinks.push(neighbor.hash);
      }
      prevLastSeenRef.current[neighbor.hash] = neighbor.lastSeen;
    }
    
    if (newBlinks.length > 0) {
      // Use queueMicrotask to avoid synchronous setState in effect
      queueMicrotask(() => {
        setBlinkingHashes(prev => {
          const next = new Set(prev);
          newBlinks.forEach(h => next.add(h));
          return next;
        });
      });
      
      // Clear blink after animation
      setTimeout(() => {
        setBlinkingHashes(prev => {
          const next = new Set(prev);
          newBlinks.forEach(h => next.delete(h));
          return next;
        });
      }, BLINK_DURATION);
    }
  }, [processedNeighbors]);

  // Check if we have valid local coordinates
  const hasLocalCoords = localLat !== 0 && localLon !== 0;

  if (!hasLocalCoords) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-text-muted">
        <Compass className="w-8 h-8 mb-2 opacity-50" />
        <p>Local node coordinates not configured</p>
        <p className="text-xs mt-1">Set latitude/longitude in config to enable</p>
      </div>
    );
  }

  if (totalNeighbors === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-text-muted">
        <Compass className="w-8 h-8 mb-2 opacity-50" />
        <p>No neighbors with location data</p>
      </div>
    );
  }

  // SVG dimensions
  const size = 280;
  const center = size / 2;
  const radius = (size / 2) - 30; // Leave room for labels

  // Convert polar to cartesian (bearing 0 = up/north)
  const polarToXY = (bearing: number, normalizedDist: number): { x: number; y: number } => {
    // Convert bearing to radians, offset so 0° is up
    const angleRad = ((bearing - 90) * Math.PI) / 180;
    const r = normalizedDist * radius;
    return {
      x: center + r * Math.cos(angleRad),
      y: center + r * Math.sin(angleRad),
    };
  };

  // Grid circles (25%, 50%, 75%, 100%)
  const gridCircles = [0.25, 0.5, 0.75, 1];

  return (
    <div className="flex flex-col h-full">
      {/* Summary */}
      <div className="text-xs text-text-muted uppercase tracking-wide mb-2">
        {totalNeighbors} neighbor{totalNeighbors !== 1 ? 's' : ''} • 
        max {maxDistance.toFixed(1)} km
      </div>
      
      {/* Radar SVG */}
      <div className="relative h-[280px]">
        <svg width={size} height={size} className="mx-auto">
          {/* SVG Definitions for animations */}
          <defs>
            <style>
              {`
                @keyframes radar-pulse-scale {
                  0% {
                    transform: scale(0);
                    opacity: 0.9;
                    stroke-width: 10;
                  }
                  100% {
                    transform: scale(1);
                    opacity: 0;
                    stroke-width: 1;
                  }
                }
                @keyframes local-node-ping {
                  0% {
                    fill: ${LOCAL_NODE_PING_COLOR};
                  }
                  100% {
                    fill: ${LOCAL_NODE_COLOR};
                  }
                }
                @keyframes neighbor-blink-scale {
                  0%, 100% {
                    transform: scale(1);
                    opacity: 0;
                  }
                  50% {
                    transform: scale(1.3);
                    opacity: 0.8;
                  }
                }
                .radar-pulse-circle {
                  transform-origin: center;
                  animation: radar-pulse-scale ${PULSE_DURATION}ms cubic-bezier(0.15, 0.6, 0.4, 1) forwards;
                }
                .local-node-ping {
                  animation: local-node-ping ${LOCAL_PING_DURATION}ms ease-out forwards;
                }
                .neighbor-blink-ring {
                  transform-origin: center;
                  animation: neighbor-blink-scale ${BLINK_DURATION}ms ease-out forwards;
                }
              `}
            </style>
          </defs>
          
          {/* Grid circles */}
          {gridCircles.map((scale) => (
            <circle
              key={scale}
              cx={center}
              cy={center}
              r={radius * scale}
              fill="none"
              stroke="rgba(255,255,255,0.1)"
              strokeWidth={1}
            />
          ))}
          
          {/* Radar pulse - expanding circle from center */}
          {pulseKey > 0 && (
            <circle
              key={`pulse-${pulseKey}`}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke="rgba(255,255,255,0.5)"
              strokeWidth={1.5}
              className="radar-pulse-circle"
            />
          )}
          
          {/* Compass lines (N-S, E-W, diagonals) */}
          {DIRECTIONS.map((dir, i) => {
            const angle = i * 45;
            const end = polarToXY(angle, 1);
            return (
              <line
                key={dir}
                x1={center}
                y1={center}
                x2={end.x}
                y2={end.y}
                stroke="rgba(255,255,255,0.08)"
                strokeWidth={1}
              />
            );
          })}
          
          {/* Direction labels */}
          {DIRECTIONS.map((dir, i) => {
            const angle = i * 45;
            const pos = polarToXY(angle, 1.12);
            return (
              <text
                key={dir}
                x={pos.x}
                y={pos.y}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="rgba(255,255,255,0.5)"
                fontSize={10}
                fontFamily="'JetBrains Mono', monospace"
              >
                {dir}
              </text>
            );
          })}
          
          {/* Center dot (local node) - with ping animation on pulse */}
          <circle
            key={`local-${pulseKey}`}
            cx={center}
            cy={center}
            r={6}
            fill={LOCAL_NODE_COLOR}
            stroke="rgba(255,255,255,0.3)"
            strokeWidth={1}
            className={pulseKey > 0 ? 'local-node-ping' : ''}
          />
          
          {/* Neighbor dots */}
          {processedNeighbors.map((neighbor) => {
            const { x, y } = polarToXY(neighbor.bearing, neighbor.normalizedDistance);
            const color = getSnrColor(neighbor.snr);
            const isHovered = hoveredNeighbor?.hash === neighbor.hash;
            const isBlinking = blinkingHashes.has(neighbor.hash);
            
            return (
              <g key={neighbor.hash}>
                {/* Blink ring on new data */}
                {isBlinking && (
                  <circle
                    cx={x}
                    cy={y}
                    r={12}
                    fill="none"
                    stroke="rgba(255,255,255,0.9)"
                    strokeWidth={2}
                    className="neighbor-blink-ring"
                  />
                )}
                {/* Glow effect for hovered */}
                {isHovered && (
                  <circle
                    cx={x}
                    cy={y}
                    r={12}
                    fill={color}
                    opacity={0.3}
                  />
                )}
                <circle
                  cx={x}
                  cy={y}
                  r={isHovered ? 8 : 6}
                  fill={color}
                  stroke="rgba(0,0,0,0.5)"
                  strokeWidth={1}
                  style={{ cursor: 'pointer', transition: 'r 0.15s' }}
                  onMouseEnter={() => setHoveredNeighbor(neighbor)}
                  onMouseLeave={() => setHoveredNeighbor(null)}
                />
              </g>
            );
          })}
        </svg>
        
        {/* Tooltip */}
        {hoveredNeighbor && (
          <div 
            className="absolute bg-bg-surface/95 backdrop-blur-sm border border-border-subtle rounded-lg px-3 py-2 text-sm pointer-events-none z-10"
            style={{
              left: '50%',
              bottom: 8,
              transform: 'translateX(-50%)',
            }}
          >
            <div className="font-medium text-text-primary">{hoveredNeighbor.name}</div>
            <div className="text-text-muted text-xs font-mono">{hoveredNeighbor.hash}</div>
            <div className="flex gap-3 mt-1 text-xs">
              <span>
                <span className="text-text-muted">SNR:</span>{' '}
                <span className="tabular-nums" style={{ color: getSnrColor(hoveredNeighbor.snr) }}>
                  {hoveredNeighbor.snr.toFixed(1)} dB
                </span>
                <span className="text-text-muted ml-1">({getSnrQuality(hoveredNeighbor.snr)})</span>
              </span>
            </div>
            <div className="flex gap-3 text-xs">
              <span>
                <span className="text-text-muted">Distance:</span>{' '}
                <span className="tabular-nums text-text-secondary">{hoveredNeighbor.distance.toFixed(2)} km</span>
              </span>
              <span>
                <span className="text-text-muted">Bearing:</span>{' '}
                <span className="tabular-nums text-text-secondary">{hoveredNeighbor.bearing.toFixed(0)}°</span>
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export const NeighborPolarChart = memo(NeighborPolarChartComponent);
