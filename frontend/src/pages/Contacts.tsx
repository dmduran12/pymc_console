import { useMemo, useState, useCallback } from 'react';
import { useStore, useHiddenContacts, useHideContact, useQuickNeighbors } from '@/lib/stores/useStore';
import { useHubNodes, useCentrality } from '@/lib/stores/useTopologyStore';
import { Share2, ArrowLeftRight, MonitorSmartphone, MessagesSquare, MapPin, Users, X, Network, ArrowUpDown, Clock, Ruler, Activity, Search, Trash2 } from 'lucide-react';
import { formatRelativeTime } from '@/lib/format';
import { SignalIcon } from '@/components/packets/SignalIndicator';
import ContactsMapWrapper from '@/components/contacts/ContactsMapWrapper';
import { PathHealthPanel } from '@/components/contacts/PathHealthPanel';
import { HashBadge } from '@/components/ui/HashBadge';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { NodeSparkline } from '@/components/contacts/NodeSparkline';

// Get signal color for card badges based on SNR
function getSignalColor(snr?: number): string {
  if (snr === undefined) return 'bg-[var(--signal-unknown)]';
  if (snr >= 5) return 'bg-[var(--signal-excellent)]';
  if (snr >= 0) return 'bg-[var(--signal-good)]';
  if (snr >= -5) return 'bg-[var(--signal-fair)]';
  if (snr >= -10) return 'bg-[var(--signal-poor)]';
  return 'bg-[var(--signal-critical)]';
}

// Calculate distance between two coordinates in meters using Haversine formula
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Format distance for display
function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}

// Sort options
type SortField = 'lastHeard' | 'distance' | 'centrality';
type SortDirection = 'asc' | 'desc';

export default function Contacts() {
  const { stats } = useStore();
  const hiddenContacts = useHiddenContacts();
  const hideContact = useHideContact();
  const hubNodes = useHubNodes();
  const centrality = useCentrality();
  const quickNeighbors = useQuickNeighbors();
  
  // Confirmation modal state
  const [pendingRemove, setPendingRemove] = useState<{ hash: string; name: string } | null>(null);
  
  // Sort state
  const [sortField, setSortField] = useState<SortField>('lastHeard');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  
  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  
  // Neighbors-only filter toggle
  const [showNeighborsOnly, setShowNeighborsOnly] = useState(false);
  
  // Selected node for zoom-to-map
  const [selectedNodeHash, setSelectedNodeHash] = useState<string | null>(null);
  // Highlighted topology edge (from PathHealth panel)
  const [highlightedEdgeKey, setHighlightedEdgeKey] = useState<string | null>(null);
  
  // Memoize contacts to prevent unnecessary downstream re-renders
  const contacts = useMemo(() => stats?.neighbors ?? {}, [stats?.neighbors]);
  
  // Filter out hidden contacts
  const visibleContacts = useMemo(() => {
    return Object.fromEntries(
      Object.entries(contacts).filter(([hash]) => !hiddenContacts.has(hash))
    );
  }, [contacts, hiddenContacts]);
  
  // Get local node info from config (memoized to prevent object recreation)
  const localNode = useMemo(() => {
    return stats?.config?.repeater ? {
      latitude: stats.config.repeater.latitude,
      longitude: stats.config.repeater.longitude,
      name: stats.config.node_name || 'Local Node'
    } : undefined;
  }, [stats]);
  
  // Get local hash for zero-hop detection
  const localHash = stats?.local_hash;
  
  // Calculate distances for all contacts
  const contactDistances = useMemo(() => {
    const distances = new Map<string, number | null>();
    if (!localNode?.latitude || !localNode?.longitude) return distances;
    
    for (const [hash, contact] of Object.entries(visibleContacts)) {
      if (contact.latitude && contact.longitude && contact.latitude !== 0 && contact.longitude !== 0) {
        distances.set(hash, calculateDistance(
          localNode.latitude, localNode.longitude,
          contact.latitude, contact.longitude
        ));
      } else {
        distances.set(hash, null);
      }
    }
    return distances;
  }, [visibleContacts, localNode]);
  
  // Build set of neighbor hashes - nodes we've received zero-hop ADVERTs from
  // MeshCore definition: path_len == 0 means direct RF contact (no forwarders)
  // Also build a map for signal data lookup
  //
  // NOTE: We intentionally do NOT merge lastHopNeighbors here because:
  //   - quickNeighbors = true zero-hop (ADVERTs with path_len == 0, MeshCore algorithm)
  //   - lastHopNeighbors = last forwarder for multi-hop ADVERTs (NOT zero-hop)
  const { neighborHashSet, neighborSignalMap } = useMemo(() => {
    const set = new Set<string>();
    const signalMap = new Map<string, { avgRssi: number | null; avgSnr: number | null }>();
    
    // Source: quickNeighbors from main store (true zero-hop neighbors)
    for (const qn of quickNeighbors) {
      set.add(qn.hash);
      signalMap.set(qn.hash, { avgRssi: qn.avgRssi, avgSnr: qn.avgSnr });
    }
    
    return { neighborHashSet: set, neighborSignalMap: signalMap };
  }, [quickNeighbors]);
  
  // Filter contacts based on search query and neighbors toggle
  const filteredContacts = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    
    // Check if search query is "neighbor" or "neighbors" - treat as filter
    const isNeighborSearch = query === 'neighbor' || query === 'neighbors';
    const shouldFilterNeighbors = showNeighborsOnly || isNeighborSearch;
    
    return Object.fromEntries(
      Object.entries(visibleContacts).filter(([hash, contact]) => {
        // If neighbors-only filter is active, check membership first
        if (shouldFilterNeighbors && !neighborHashSet.has(hash)) {
          return false;
        }
        
        // If filtering by neighbors keyword, skip text search
        if (isNeighborSearch) return true;
        
        // If no search query, show all (that passed neighbor filter)
        if (!query) return true;
        
        // Text search on name, prefix, and full hash
        const name = (contact.node_name || contact.name || '').toLowerCase();
        const prefix = hash.slice(2, 4).toLowerCase(); // Extract 2-char prefix from hash
        return name.includes(query) || prefix.includes(query) || hash.toLowerCase().includes(query);
      })
    );
  }, [visibleContacts, searchQuery, showNeighborsOnly, neighborHashSet]);
  
  // Sort contacts based on current sort field and direction
  const sortedContacts = useMemo(() => {
    const entries = Object.entries(filteredContacts);
    
    return entries.sort(([hashA, contactA], [hashB, contactB]) => {
      let comparison = 0;
      
      switch (sortField) {
        case 'lastHeard':
          comparison = (contactA.last_seen || 0) - (contactB.last_seen || 0);
          break;
        case 'distance': {
          const distA = contactDistances.get(hashA) ?? null;
          const distB = contactDistances.get(hashB) ?? null;
          // Null/undefined distances go to the end
          if (distA === null && distB === null) comparison = 0;
          else if (distA === null) comparison = 1;
          else if (distB === null) comparison = -1;
          else comparison = distA - distB;
          break;
        }
        case 'centrality': {
          const centA = centrality.get(hashA) || 0;
          const centB = centrality.get(hashB) || 0;
          comparison = centA - centB;
          break;
        }
      }
      
      return sortDirection === 'desc' ? -comparison : comparison;
    });
  }, [filteredContacts, sortField, sortDirection, contactDistances, centrality]);
  
  // Count contacts with location data
  const contactsWithLocation = sortedContacts.filter(
    ([, n]) => n.latitude && n.longitude && n.latitude !== 0 && n.longitude !== 0
  ).length;
  
  // Hub nodes from topology store (computed by worker)
  const hubNodeSet = useMemo(() => new Set(hubNodes), [hubNodes]);
  
  // Handle sort button click
  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      // Toggle direction
      setSortDirection(prev => prev === 'desc' ? 'asc' : 'desc');
    } else {
      // Switch field, default to desc
      setSortField(field);
      setSortDirection('desc');
    }
  }, [sortField]);
  
  // Handle node row click
  const handleNodeClick = useCallback((hash: string) => {
    const contact = visibleContacts[hash];
    if (contact?.latitude && contact?.longitude && contact.latitude !== 0 && contact.longitude !== 0) {
      setSelectedNodeHash(hash);
    }
  }, [visibleContacts]);
  
  // Clear selection after map zooms
  const handleNodeSelected = useCallback(() => {
    setSelectedNodeHash(null);
  }, []);

  return (
    <div className="section-gap">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
        <h1 className="type-title text-text-primary flex items-center gap-3">
          <Users className="w-6 h-6 text-accent-primary flex-shrink-0" />
          Contacts
        </h1>
        <div className="flex items-baseline gap-3 sm:gap-4">
          <span className="roster-title tabular-nums">{sortedContacts.length} node{sortedContacts.length !== 1 ? 's' : ''}</span>
          {contactsWithLocation > 0 && (
            <span className="roster-title flex items-baseline gap-1.5 tabular-nums">
              <MapPin className="w-3.5 h-3.5 relative top-[2px]" />
              {contactsWithLocation} with location
            </span>
          )}
        </div>
      </div>
      
      {/* Map */}
      <div className="relative">
        <ContactsMapWrapper 
          neighbors={visibleContacts} 
          localNode={localNode}
          localHash={localHash}
          onRemoveNode={hideContact}
          selectedNodeHash={selectedNodeHash}
          onNodeSelected={handleNodeSelected}
          highlightedEdgeKey={highlightedEdgeKey}
        />
      </div>
      
      {/* Path Health Panel */}
      <PathHealthPanel 
        maxPaths={10}
        highlightedEdge={highlightedEdgeKey}
        onHighlightEdge={setHighlightedEdgeKey}
      />

      {/* Contacts List */}
      <div className="chart-container">
        <div className="chart-header">
          <div className="chart-title">
            <Users className="chart-title-icon" />
            Discovered Contacts
          </div>
          
          {/* Search and sort controls */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Neighbors filter toggle */}
            {neighborHashSet.size > 0 && (
              <button
                onClick={() => setShowNeighborsOnly(!showNeighborsOnly)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg transition-colors min-h-[32px] order-1 sm:order-1 ${
                  showNeighborsOnly
                    ? 'bg-accent-success/20 text-accent-success border border-accent-success/30'
                    : 'text-text-muted hover:text-text-secondary hover:bg-white/5 border border-transparent'
                }`}
                title={showNeighborsOnly ? 'Show all contacts' : 'Show only MeshCore neighbors (direct RF contact)'}
              >
                <ChevronsLeftRightEllipsis className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Neighbors</span>
                <span className="sm:hidden">{neighborHashSet.size}</span>
                {showNeighborsOnly && (
                  <span className="text-[10px] font-semibold tabular-nums">{neighborHashSet.size}</span>
                )}
              </button>
            )}
            
            {/* Search bar */}
            <div className="relative order-2 sm:order-2">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search..."
                className="w-28 sm:w-32 pl-7 pr-7 py-1.5 text-xs bg-white/5 border border-white/10 rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-primary/50"
              />
              {searchQuery && (
                <button
                  onClick={() => {
                    setSearchQuery('');
                    // If search was "neighbor(s)", also clear the toggle
                    if (searchQuery.toLowerCase().trim() === 'neighbor' || searchQuery.toLowerCase().trim() === 'neighbors') {
                      setShowNeighborsOnly(false);
                    }
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary p-0.5"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            
            {/* Sort buttons */}
            <div className="flex items-center gap-1 order-1 sm:order-2">
              <button
                onClick={() => handleSort('lastHeard')}
                className={`flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg transition-colors min-h-[32px] ${
                  sortField === 'lastHeard' 
                    ? 'bg-accent-primary/20 text-accent-primary' 
                    : 'text-text-muted hover:text-text-secondary hover:bg-white/5'
                }`}
                title="Sort by last heard"
              >
                <Clock className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Recent</span>
                {sortField === 'lastHeard' && (
                  <ArrowUpDown className={`w-3 h-3 ${sortDirection === 'asc' ? 'rotate-180' : ''}`} />
                )}
              </button>
              <button
                onClick={() => handleSort('distance')}
                className={`flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg transition-colors min-h-[32px] ${
                  sortField === 'distance' 
                    ? 'bg-accent-primary/20 text-accent-primary' 
                    : 'text-text-muted hover:text-text-secondary hover:bg-white/5'
                }`}
                title="Sort by distance"
              >
                <Ruler className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Distance</span>
                {sortField === 'distance' && (
                  <ArrowUpDown className={`w-3 h-3 ${sortDirection === 'asc' ? 'rotate-180' : ''}`} />
                )}
              </button>
              <button
                onClick={() => handleSort('centrality')}
                className={`flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg transition-colors min-h-[32px] ${
                  sortField === 'centrality' 
                    ? 'bg-accent-primary/20 text-accent-primary' 
                    : 'text-text-muted hover:text-text-secondary hover:bg-white/5'
                }`}
                title="Sort by network centrality"
              >
                <Activity className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Centrality</span>
                {sortField === 'centrality' && (
                  <ArrowUpDown className={`w-3 h-3 ${sortDirection === 'asc' ? 'rotate-180' : ''}`} />
                )}
              </button>
            </div>
          </div>
        </div>
        
        {sortedContacts.length > 0 ? (
          <div className="roster-list">
            {sortedContacts.map(([hash, contact], index) => {
              const hasLocation = contact.latitude && contact.longitude && 
                                  contact.latitude !== 0 && contact.longitude !== 0;
              const displayName = contact.node_name || contact.name || 'Unknown';
              const isHub = hubNodeSet.has(hash);
              const isNeighbor = neighborHashSet.has(hash);
              const distance = contactDistances.get(hash);
              const nodeCentrality = centrality.get(hash) || 0;
              
              // Get signal data ONLY for bidirectional neighbors
              // Signal from non-neighbors is misleading (it's from the last hop, not the contact)
              const neighborSignal = isNeighbor ? neighborSignalMap.get(hash) : undefined;
              const showSignal = isNeighbor && neighborSignal;
              
              return (
                <div key={hash}>
                  <div 
                    className={`roster-row ${isHub ? 'bg-amber-500/5 border-l-2 border-l-amber-400' : ''} ${hasLocation ? 'cursor-pointer hover:bg-white/[0.02]' : ''}`}
                    onClick={() => handleNodeClick(hash)}
                  >
                    {/* Icon with signal indicator - only show signal dot for neighbors */}
                    <div className="relative flex-shrink-0">
                      <div className="roster-icon">
                        {(() => {
                          const ct = contact.contact_type?.toLowerCase();
                          const isRoomServer = ct === 'room server' || ct === 'room_server' || ct === 'room' || ct === 'server';
                          const isCompanion = ct === 'companion' || ct === 'client' || ct === 'cli';
                          
                          if (isRoomServer) {
                            // Room server (regardless of repeater status)
                            return <MessagesSquare className="w-5 h-5 text-indigo-400" />;
                          } else if (isCompanion) {
                            // Companion/client device
                            return <MonitorSmartphone className="w-5 h-5 text-text-muted" />;
                          } else if (contact.is_repeater || ct === 'repeater' || ct === 'rep') {
                            // Repeater - different icon based on neighbor status
                            return isNeighbor 
                              ? <ArrowLeftRight className="w-5 h-5 text-accent-success" />
                              : <Share2 className="w-5 h-5 text-accent-primary" />;
                          } else {
                            // Unknown type - default to companion icon
                            return <MonitorSmartphone className="w-5 h-5 text-text-muted" />;
                          }
                        })()}
                      </div>
                      {/* Signal indicator dot - ONLY for bidirectional neighbors */}
                      {showSignal && neighborSignal?.avgSnr !== null && (
                        <div className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${getSignalColor(neighborSignal.avgSnr)} border-2 border-bg-surface`} />
                      )}
                    </div>
                    
                    {/* Main content - name, badges, hash */}
                    <div className="roster-content min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="roster-title">{displayName}</span>
                        {isNeighbor && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded" style={{ backgroundColor: 'rgba(57, 217, 138, 0.2)', color: '#39D98A' }}>
                            NBR
                          </span>
                        )}
                        {isHub && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded flex items-center gap-1" style={{ backgroundColor: 'rgba(251, 191, 36, 0.2)', color: '#FBBF24' }}>
                            <Network className="w-3 h-3" />
                            HUB
                          </span>
                        )}
                        {(contact.is_repeater || contact.contact_type?.toLowerCase() === 'repeater' || contact.contact_type?.toLowerCase() === 'rep') && (
                          <span className="pill-tag">RPT</span>
                        )}
                      </div>
                      {/* Hash: full on desktop (md+), truncated on mobile */}
                      <div className="hidden md:block">
                        <HashBadge hash={hash} size="sm" full />
                      </div>
                      <div className="md:hidden">
                        <HashBadge hash={hash} size="sm" prefixLength={8} suffixLength={6} />
                      </div>
                    </div>
                    
                    {/* Metrics - Signal ONLY for neighbors, then distance, then centrality */}
                    <div className="roster-metrics flex-shrink-0">
                      {/* Signal metrics - ONLY for bidirectional neighbors */}
                      {showSignal && neighborSignal?.avgRssi !== null && (
                        <div className="flex items-center gap-1.5">
                          <SignalIcon rssi={neighborSignal.avgRssi} className="w-3.5 h-3.5" />
                          <span className="type-data-xs tabular-nums">{Math.round(neighborSignal.avgRssi)}</span>
                        </div>
                      )}
                      {showSignal && neighborSignal?.avgSnr !== null && (
                        <div className="flex items-center gap-1.5">
                          <span className="type-data-xs tabular-nums">{neighborSignal.avgSnr.toFixed(1)} dB</span>
                        </div>
                      )}
                      {/* Distance */}
                      {distance !== null && distance !== undefined && (
                        <div className="flex items-center gap-1 text-accent-tertiary">
                          <Ruler className="w-3 h-3" />
                          <span className="type-data-xs tabular-nums">{formatDistance(distance)}</span>
                        </div>
                      )}
                      {/* Centrality */}
                      {nodeCentrality > 0 && (
                        <div className="flex items-center gap-1 text-amber-400/70">
                          <Activity className="w-3 h-3" />
                          <span className="type-data-xs tabular-nums">{(nodeCentrality * 100).toFixed(0)}%</span>
                        </div>
                      )}
                      {/* 7-day activity sparkline (health-colored) */}
                      <div className="hidden sm:block">
                        <NodeSparkline 
                          nodeHash={hash} 
                          width={48} 
                          height={16} 
                        />
                      </div>
                    </div>
                    
                    {/* Last seen */}
                    <div className="roster-metric flex-shrink-0">
                      {contact.last_seen ? formatRelativeTime(contact.last_seen) : '—'}
                    </div>
                    
                    {/* Remove button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingRemove({ hash, name: displayName });
                      }}
                      className="ml-2 p-1.5 rounded-lg text-text-muted/50 hover:text-red-400 hover:bg-red-500/10 transition-colors flex-shrink-0"
                      title="Remove contact"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  
                  {/* Separator between rows */}
                  {index < sortedContacts.length - 1 && (
                    <div className="roster-separator" />
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="roster-empty">
            <Users className="roster-empty-icon" />
            <div className="roster-empty-title">No Contacts Discovered</div>
            <div className="roster-empty-text">
              Contacts will appear here as they advertise on the mesh network.
            </div>
          </div>
        )}
      </div>
      
      {/* Confirmation Modal */}
      <ConfirmModal
        isOpen={!!pendingRemove}
        title="Remove Contact"
        message={`Are you sure you would like to remove ${pendingRemove?.name || 'this contact'}?`}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          if (pendingRemove) {
            hideContact(pendingRemove.hash);
          }
          setPendingRemove(null);
        }}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  );
}
