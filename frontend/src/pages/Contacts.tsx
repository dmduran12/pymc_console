import { useMemo, useState } from 'react';
import { useStore, useHiddenContacts, useHideContact } from '@/lib/stores/useStore';
import { useHubNodes } from '@/lib/stores/useTopologyStore';
import { Signal, Radio, MapPin, Repeat, Users, X, Network } from 'lucide-react';
import { formatRelativeTime } from '@/lib/format';
import ContactsMapWrapper from '@/components/contacts/ContactsMapWrapper';
import { HashBadge } from '@/components/ui/HashBadge';
import { ConfirmModal } from '@/components/ui/ConfirmModal';

// Get signal color for card badges based on SNR
function getSignalColor(snr?: number): string {
  if (snr === undefined) return 'bg-[var(--signal-unknown)]';
  if (snr >= 5) return 'bg-[var(--signal-excellent)]';
  if (snr >= 0) return 'bg-[var(--signal-good)]';
  if (snr >= -5) return 'bg-[var(--signal-fair)]';
  if (snr >= -10) return 'bg-[var(--signal-poor)]';
  return 'bg-[var(--signal-critical)]';
}

export default function Contacts() {
  const { stats } = useStore();
  const hiddenContacts = useHiddenContacts();
  const hideContact = useHideContact();
  const hubNodes = useHubNodes();
  
  // Confirmation modal state
  const [pendingRemove, setPendingRemove] = useState<{ hash: string; name: string } | null>(null);
  
  const contacts = stats?.neighbors ?? {};
  
  // Filter out hidden contacts
  const visibleContacts = useMemo(() => {
    return Object.fromEntries(
      Object.entries(contacts).filter(([hash]) => !hiddenContacts.has(hash))
    );
  }, [contacts, hiddenContacts]);
  
  const contactEntries = Object.entries(visibleContacts);
  
  // Get local node info from config
  const localNode = stats?.config?.repeater ? {
    latitude: stats.config.repeater.latitude,
    longitude: stats.config.repeater.longitude,
    name: stats.config.node_name || 'Local Node'
  } : undefined;
  
  // Get local hash for zero-hop detection
  const localHash = stats?.local_hash;
  
  // Count contacts with location data
  const contactsWithLocation = contactEntries.filter(
    ([, n]) => n.latitude && n.longitude && n.latitude !== 0 && n.longitude !== 0
  ).length;
  
  // Hub nodes from topology store (computed by worker)
  const hubNodeSet = useMemo(() => new Set(hubNodes), [hubNodes]);

  return (
    <div className="section-gap">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
        <h1 className="type-title text-text-primary flex items-center gap-3">
          <Users className="w-6 h-6 text-accent-primary flex-shrink-0" />
          Contacts
        </h1>
        <div className="flex items-baseline gap-3 sm:gap-4">
          <span className="roster-title tabular-nums">{contactEntries.length} node{contactEntries.length !== 1 ? 's' : ''}</span>
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
        />
      </div>

      {/* Contacts List */}
      <div className="chart-container">
        <div className="chart-header">
          <div className="chart-title">
            <Users className="chart-title-icon" />
            Discovered Nodes
          </div>
          <span className="type-data-xs text-text-muted tabular-nums">
            {contactEntries.length} total
          </span>
        </div>
        
        {contactEntries.length > 0 ? (
          <div className="roster-list">
            {contactEntries.map(([hash, contact], index) => {
              const hasLocation = contact.latitude && contact.longitude && 
                                  contact.latitude !== 0 && contact.longitude !== 0;
              const displayName = contact.node_name || contact.name || 'Unknown';
              const isHub = hubNodeSet.has(hash);
              
              return (
                <div key={hash}>
                  <div className={`roster-row ${isHub ? 'bg-amber-500/5 border-l-2 border-l-amber-400' : ''}`}>
                    {/* Icon with signal indicator */}
                    <div className="relative">
                      <div className="roster-icon">
                        {contact.is_repeater ? (
                          <Repeat className="w-5 h-5 text-accent-primary" />
                        ) : (
                          <Radio className="w-5 h-5 text-text-muted" />
                        )}
                      </div>
                      <div className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${getSignalColor(contact.snr)} border-2 border-bg-surface`} />
                    </div>
                    
                    {/* Main content */}
                    <div className="roster-content">
                      <div className="flex items-center gap-2">
                        <span className="roster-title">{displayName}</span>
                        {isHub && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded flex items-center gap-1" style={{ backgroundColor: 'rgba(251, 191, 36, 0.2)', color: '#FBBF24' }}>
                            <Network className="w-3 h-3" />
                            HUB
                          </span>
                        )}
                        {contact.is_repeater && (
                          <span className="pill-tag">RPT</span>
                        )}
                      </div>
                      <HashBadge hash={hash} size="sm" />
                    </div>
                    
                    {/* Metrics row */}
                    <div className="roster-metrics">
                      {contact.rssi !== undefined && (
                        <div className="flex items-center gap-1.5">
                          <Signal className="w-3.5 h-3.5" />
                          <span className="type-data-xs tabular-nums">{contact.rssi}</span>
                        </div>
                      )}
                      {contact.snr !== undefined && (
                        <div className="flex items-center gap-1.5">
                          <span className="type-data-xs tabular-nums">{contact.snr.toFixed(1)} dB</span>
                        </div>
                      )}
                      {hasLocation && (
                        <MapPin className="w-3.5 h-3.5 text-accent-tertiary" />
                      )}
                    </div>
                    
                    {/* Last seen */}
                    <div className="roster-metric">
                      {contact.last_seen ? formatRelativeTime(contact.last_seen) : '—'}
                    </div>
                    
                    {/* Remove button */}
                    <button
                      onClick={() => setPendingRemove({ hash, name: displayName })}
                      className="ml-2 p-1.5 rounded-lg text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      title="Remove node"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  
                  {/* Separator between rows */}
                  {index < contactEntries.length - 1 && (
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
