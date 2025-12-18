import { Suspense, lazy, Component, ReactNode } from 'react';
import { NeighborInfo, Packet } from '@/types/api';

interface LocalNode {
  latitude: number;
  longitude: number;
  name: string;
}

interface NeighborMapWrapperProps {
  neighbors: Record<string, NeighborInfo>;
  localNode?: LocalNode;
  packets?: Packet[];
  onRemoveNode?: (hash: string) => void;
}

// Error boundary to catch Leaflet loading errors
interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

class MapErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="glass-card h-[400px] flex items-center justify-center">
          <div className="text-center text-white/50 p-4">
            <p className="text-lg mb-2">Map failed to load</p>
            <p className="text-sm text-white/30">
              {this.state.error?.message || 'Unknown error'}
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Lazy import - Leaflet requires window object
const NeighborMap = lazy(() => import('./NeighborMap'));

export default function NeighborMapWrapper({ neighbors, localNode, packets, onRemoveNode }: NeighborMapWrapperProps) {
  return (
    <MapErrorBoundary>
      <Suspense fallback={
        <div className="glass-card h-[400px] flex items-center justify-center">
          <div className="text-white/50">Loading map...</div>
        </div>
      }>
        <NeighborMap neighbors={neighbors} localNode={localNode} packets={packets} onRemoveNode={onRemoveNode} />
      </Suspense>
    </MapErrorBoundary>
  );
}
