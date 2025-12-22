import { memo, useMemo } from 'react';
import { NeighborInfo } from '@/types/api';

interface NetworkCompositionChartProps {
  neighbors: Record<string, NeighborInfo>;
}

interface CompositionItem {
  label: string;
  count: number;
  percent: number;
  color: string;
}

// Color palette for contact types - matches design system
const TYPE_COLORS: Record<string, string> = {
  repeater: 'var(--accent-primary)',      // Lavender
  companion: 'var(--accent-tertiary)',    // Cyan/mint
  room_server: 'var(--accent-secondary)', // Yellow
  unknown: 'var(--signal-fair)',          // Muted yellow
};

/**
 * Categorize a neighbor by contact_type field or infer from is_repeater
 */
function categorizeContact(contact: NeighborInfo): string {
  // Prefer explicit contact_type if available
  // Note: "Chat Node" is normalized to "Companion" in api.ts
  if (contact.contact_type) {
    const ct = contact.contact_type.toLowerCase();
    if (ct === 'repeater' || ct === 'rep') return 'repeater';
    if (ct === 'room server' || ct === 'room_server' || ct === 'room' || ct === 'server') return 'room_server';
    if (ct === 'companion' || ct === 'client' || ct === 'cli') return 'companion';
  }
  
  // Fallback: use is_repeater flag
  if (contact.is_repeater) return 'repeater';
  
  // Default to companion for nodes without explicit type
  return 'companion';
}

/**
 * Horizontal bar chart showing network composition by node type.
 * Analyzes all neighbors and categorizes them by contact_type.
 */
function NetworkCompositionChartComponent({ neighbors }: NetworkCompositionChartProps) {
  const composition = useMemo(() => {
    const counts: Record<string, number> = {
      repeater: 0,
      companion: 0,
      room_server: 0,
    };
    
    // Count each neighbor by type
    for (const contact of Object.values(neighbors)) {
      const type = categorizeContact(contact);
      counts[type] = (counts[type] || 0) + 1;
    }
    
    const total = Object.values(counts).reduce((sum, c) => sum + c, 0);
    
    // Build sorted composition items (largest first)
    const items: CompositionItem[] = [
      { label: 'Repeaters', count: counts.repeater, percent: 0, color: TYPE_COLORS.repeater },
      { label: 'Companions', count: counts.companion, percent: 0, color: TYPE_COLORS.companion },
      { label: 'Room Servers', count: counts.room_server, percent: 0, color: TYPE_COLORS.room_server },
    ]
      .map(item => ({
        ...item,
        percent: total > 0 ? (item.count / total) * 100 : 0,
      }))
      .filter(item => item.count > 0) // Only show types with nodes
      .sort((a, b) => b.count - a.count);
    
    return { items, total };
  }, [neighbors]);

  if (composition.total === 0) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted type-body-sm">
        No neighbors discovered yet
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {composition.items.map((item) => (
        <div key={item.label} className="flex flex-col gap-1.5">
          {/* Label row */}
          <div className="flex items-center justify-between">
            <span className="type-data-sm text-text-secondary">{item.label}</span>
            <span className="type-data-sm text-text-muted tabular-nums">
              {item.count} <span className="text-text-muted/60">({item.percent.toFixed(0)}%)</span>
            </span>
          </div>
          
          {/* Progress bar */}
          <div className="h-2.5 bg-bg-elevated rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500 ease-out"
              style={{
                width: `${item.percent}%`,
                backgroundColor: item.color,
                minWidth: item.count > 0 ? '4px' : '0',
              }}
            />
          </div>
        </div>
      ))}
      
      {/* Total footer */}
      <div className="flex items-center justify-between pt-2 mt-1 border-t border-border-subtle">
        <span className="type-data-xs text-text-muted">Total Nodes</span>
        <span className="type-data-sm text-text-primary font-medium tabular-nums">
          {composition.total}
        </span>
      </div>
    </div>
  );
}

export const NetworkCompositionChart = memo(NetworkCompositionChartComponent);
