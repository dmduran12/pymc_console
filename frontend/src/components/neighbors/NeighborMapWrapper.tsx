import { Suspense, lazy } from 'react';
import { NeighborInfo } from '@/types/api';

interface LocalNode {
  latitude: number;
  longitude: number;
  name: string;
}

interface NeighborMapWrapperProps {
  neighbors: Record<string, NeighborInfo>;
  localNode?: LocalNode;
}

// Lazy import - Leaflet requires window object
const NeighborMap = lazy(() => import('./NeighborMap'));

export default function NeighborMapWrapper({ neighbors, localNode }: NeighborMapWrapperProps) {
  return (
    <Suspense fallback={
      <div className="glass-card h-[400px] flex items-center justify-center">
        <div className="text-white/50">Loading map...</div>
      </div>
    }>
      <NeighborMap neighbors={neighbors} localNode={localNode} />
    </Suspense>
  );
}
