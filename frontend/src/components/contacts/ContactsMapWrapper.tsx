import { Suspense, lazy, Component, ReactNode, useState, useEffect } from 'react';
import { Map as MapIcon, Box } from 'lucide-react';
import { NeighborInfo } from '@/types/api';

interface LocalNode {
  latitude: number;
  longitude: number;
  name: string;
}

interface ContactsMapWrapperProps {
  neighbors: Record<string, NeighborInfo>;
  localNode?: LocalNode;
  localHash?: string;
  onRemoveNode?: (hash: string) => void;
  selectedNodeHash?: string | null;
  onNodeSelected?: () => void;
  highlightedEdgeKey?: string | null;
}

// Storage key for map mode preference
const MAP_MODE_KEY = 'pymc-map-mode';

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

// Lazy imports - both require window object
const ContactsMap = lazy(() => import('./ContactsMap'));
const ContactsMap3D = lazy(() => import('./ContactsMap3D').then(m => ({ default: m.ContactsMap3D })));

type MapMode = '2d' | '3d';

export default function ContactsMapWrapper({ neighbors, localNode, localHash, onRemoveNode, selectedNodeHash, onNodeSelected, highlightedEdgeKey }: ContactsMapWrapperProps) {
  // Persist map mode preference (default to 3D)
  const [mapMode, setMapMode] = useState<MapMode>(() => {
    if (typeof window === 'undefined') return '3d';
    const saved = localStorage.getItem(MAP_MODE_KEY);
    // Default to 3D if no preference saved
    return saved === '2d' ? '2d' : '3d';
  });
  
  // Save preference when mode changes
  useEffect(() => {
    localStorage.setItem(MAP_MODE_KEY, mapMode);
  }, [mapMode]);
  
  const toggleMapMode = () => {
    setMapMode(prev => prev === '2d' ? '3d' : '2d');
  };
  
  return (
    <MapErrorBoundary>
      {/* Map mode toggle - positioned above map */}
      <div className="flex justify-end mb-2">
        <button
          onClick={toggleMapMode}
          className="flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg transition-colors bg-surface-elevated hover:bg-white/10 border border-white/10"
          title={mapMode === '2d' ? 'Switch to 3D terrain map' : 'Switch to 2D flat map'}
        >
          {mapMode === '2d' ? (
            <>
              <Box className="w-3.5 h-3.5 text-indigo-400" />
              <span className="text-text-secondary">Enable 3D</span>
            </>
          ) : (
            <>
              <MapIcon className="w-3.5 h-3.5 text-text-muted" />
              <span className="text-text-secondary">Switch to 2D</span>
            </>
          )}
        </button>
      </div>
      
      <Suspense fallback={
        <div className="glass-card h-[500px] flex items-center justify-center">
          <div className="text-white/50">Loading map...</div>
        </div>
      }>
        {mapMode === '3d' ? (
          <ContactsMap3D 
            neighbors={neighbors} 
            localNode={localNode} 
            localHash={localHash} 
            highlightedEdgeKey={highlightedEdgeKey}
          />
        ) : (
          <ContactsMap 
            neighbors={neighbors} 
            localNode={localNode} 
            localHash={localHash} 
            onRemoveNode={onRemoveNode}
            selectedNodeHash={selectedNodeHash}
            onNodeSelected={onNodeSelected}
            highlightedEdgeKey={highlightedEdgeKey}
          />
        )}
      </Suspense>
    </MapErrorBoundary>
  );
}
