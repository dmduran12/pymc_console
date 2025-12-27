import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useStore } from '@/lib/stores/useStore';
import { Settings as SettingsIcon, Radio, Gauge, Antenna, MapPin, Pencil, Check, X, ChevronDown, Loader2 } from 'lucide-react';
import { formatFrequency, formatBandwidth } from '@/lib/format';
import { HashBadge } from '@/components/ui/HashBadge';
import { updateRadioConfig } from '@/lib/api';
import { BackgroundSelector } from '@/components/shared/BackgroundSelector';
import { PageContainer, PageHeader, Grid12, GridCell, Card } from '@/components/layout/PageLayout';
import clsx from 'clsx';

// LoRa radio parameter options
const BANDWIDTHS = [
  { value: 7.8, label: '7.8 kHz' },
  { value: 10.4, label: '10.4 kHz' },
  { value: 15.6, label: '15.6 kHz' },
  { value: 20.8, label: '20.8 kHz' },
  { value: 31.25, label: '31.25 kHz' },
  { value: 41.7, label: '41.7 kHz' },
  { value: 62.5, label: '62.5 kHz' },
  { value: 125, label: '125 kHz' },
  { value: 250, label: '250 kHz' },
  { value: 500, label: '500 kHz' },
];

const SPREADING_FACTORS = [5, 6, 7, 8, 9, 10, 11, 12];
const CODING_RATES = [
  { value: 5, label: '4/5' },
  { value: 6, label: '4/6' },
  { value: 7, label: '4/7' },
  { value: 8, label: '4/8' },
];

export default function Settings() {
  const { stats, setMode, setDutyCycle, fetchStats } = useStore();

  const radioConfig = stats?.config?.radio;
  const repeaterConfig = stats?.config?.repeater;
  const dutyCycleConfig = stats?.config?.duty_cycle;

  const nodeName = stats?.node_name || stats?.config?.node_name || 'Unknown Node';

  const currentMode = repeaterConfig?.mode ?? 'forward';
  const dutyCycleEnabled = dutyCycleConfig?.enforcement_enabled ?? false;

  const [isEditing, setIsEditing] = useState(false);
  const [formFrequency, setFormFrequency] = useState<string>('');
  const [formBandwidth, setFormBandwidth] = useState<number>(62.5);
  const [formSF, setFormSF] = useState<number>(7);
  const [formCR, setFormCR] = useState<number>(5);
  const [formTxPower, setFormTxPower] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);
  const radioCardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (radioConfig && isEditing) {
      setFormFrequency((radioConfig.frequency / 1_000_000).toFixed(3));
      setFormBandwidth(radioConfig.bandwidth / 1000);
      setFormSF(radioConfig.spreading_factor);
      setFormCR(radioConfig.coding_rate);
      setFormTxPower(String(radioConfig.tx_power));
    }
  }, [radioConfig, isEditing]);

  const hasChanges = useMemo(() => {
    if (!radioConfig || !isEditing) return false;
    const currentFreqMhz = radioConfig.frequency / 1_000_000;
    const currentBwKhz = radioConfig.bandwidth / 1000;
    const formFreqMhz = parseFloat(formFrequency) || 0;
    return (
      Math.abs(formFreqMhz - currentFreqMhz) > 0.0001 ||
      formBandwidth !== currentBwKhz ||
      formSF !== radioConfig.spreading_factor ||
      formCR !== radioConfig.coding_rate ||
      parseInt(formTxPower) !== radioConfig.tx_power
    );
  }, [radioConfig, isEditing, formFrequency, formBandwidth, formSF, formCR, formTxPower]);

  const cancelEditing = useCallback(() => {
    setIsEditing(false);
    setSaveResult(null);
    if (radioConfig) {
      setFormFrequency((radioConfig.frequency / 1_000_000).toFixed(3));
      setFormBandwidth(radioConfig.bandwidth / 1000);
      setFormSF(radioConfig.spreading_factor);
      setFormCR(radioConfig.coding_rate);
      setFormTxPower(String(radioConfig.tx_power));
    }
  }, [radioConfig]);

  useEffect(() => {
    if (!isEditing) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      if (radioCardRef.current && !radioCardRef.current.contains(e.target as Node)) {
        cancelEditing();
      }
    };
    
    document.addEventListener('mouseup', handleClickOutside);
    
    return () => {
      document.removeEventListener('mouseup', handleClickOutside);
    };
  }, [isEditing, cancelEditing]);

  const startEditing = () => {
    if (radioConfig) {
      setFormFrequency((radioConfig.frequency / 1_000_000).toFixed(3));
      setFormBandwidth(radioConfig.bandwidth / 1000);
      setFormSF(radioConfig.spreading_factor);
      setFormCR(radioConfig.coding_rate);
      setFormTxPower(String(radioConfig.tx_power));
    }
    setSaveResult(null);
    setIsEditing(true);
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveResult(null);

    try {
      const config: Record<string, number | string> = {};
      
      const newFreqMhz = parseFloat(formFrequency);
      const currentFreqMhz = radioConfig ? radioConfig.frequency / 1_000_000 : 0;
      if (Math.abs(newFreqMhz - currentFreqMhz) > 0.0001) {
        config.frequency_mhz = newFreqMhz;
      }

      const currentBwKhz = radioConfig ? radioConfig.bandwidth / 1000 : 0;
      if (formBandwidth !== currentBwKhz) {
        config.bandwidth_khz = formBandwidth;
      }

      if (formSF !== radioConfig?.spreading_factor) {
        config.spreading_factor = formSF;
      }

      if (formCR !== radioConfig?.coding_rate) {
        config.coding_rate = formCR;
      }

      const newTxPower = parseInt(formTxPower);
      if (newTxPower !== radioConfig?.tx_power) {
        config.tx_power = newTxPower;
      }

      if (Object.keys(config).length === 0) {
        setSaveResult({ success: true, message: 'No changes to save' });
        setIsSaving(false);
        return;
      }

      const result = await updateRadioConfig(config);
      
      if (result.success && result.data) {
        const applied = result.data.applied.join(', ');
        const liveNote = result.data.live_update ? ' (applied live)' : ' (restart required)';
        setSaveResult({ 
          success: true, 
          message: `Updated: ${applied}${liveNote}` 
        });
        fetchStats();
        setTimeout(() => {
          setIsEditing(false);
          setSaveResult(null);
        }, 1500);
      } else {
        setSaveResult({ success: false, message: result.error || 'Failed to save' });
      }
    } catch (err) {
      setSaveResult({ success: false, message: String(err) });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title="Settings"
        icon={<SettingsIcon />}
        controls={<BackgroundSelector />}
      />

      <Grid12>
        {/* Operating Mode */}
        <GridCell md={6}>
          <Card>
          <h2 className="text-lg font-medium text-text-primary mb-4 flex items-center gap-2">
            <Radio className="w-5 h-5 text-accent-primary" />
            Operating Mode
          </h2>
          <p className="text-sm text-text-muted mb-4">
            Control how the repeater handles incoming packets.
          </p>
          <div className="space-y-3">
            <button
              onClick={() => setMode('forward')}
              className={clsx(
                'w-full p-3 sm:p-4 rounded-lg border text-left transition-all duration-200 min-h-[64px]',
                currentMode === 'forward'
                  ? 'bg-accent-success/20 border-accent-success/50 text-accent-success'
                  : 'bg-bg-subtle border-border-subtle text-text-secondary hover:bg-bg-elevated'
              )}
            >
              <div className="font-medium text-sm sm:text-base">Forward Mode</div>
              <div className="text-xs sm:text-sm opacity-70 mt-0.5 sm:mt-1">
                Receive and retransmit to extend coverage
              </div>
            </button>
            <button
              onClick={() => setMode('monitor')}
              className={clsx(
                'w-full p-3 sm:p-4 rounded-lg border text-left transition-all duration-200 min-h-[64px]',
                currentMode === 'monitor'
                  ? 'bg-accent-secondary/20 border-accent-secondary/50 text-accent-secondary'
                  : 'bg-bg-subtle border-border-subtle text-text-secondary hover:bg-bg-elevated'
              )}
            >
              <div className="font-medium text-sm sm:text-base">Monitor Mode</div>
              <div className="text-xs sm:text-sm opacity-70 mt-0.5 sm:mt-1">
                Log packets without retransmitting
              </div>
            </button>
          </div>
          </Card>
        </GridCell>

        {/* Duty Cycle */}
        <GridCell md={6}>
          <Card>
          <h2 className="text-lg font-medium text-text-primary mb-4 flex items-center gap-2">
            <Gauge className="w-5 h-5 text-accent-primary" />
            Duty Cycle Enforcement
          </h2>
          <p className="text-sm text-text-muted mb-4">
            Limit airtime to comply with regulations.
          </p>
          <div className="space-y-3">
            <button
              onClick={() => setDutyCycle(true)}
              className={clsx(
                'w-full p-3 sm:p-4 rounded-lg border text-left transition-all duration-200 min-h-[64px]',
                dutyCycleEnabled
                  ? 'bg-accent-success/20 border-accent-success/50 text-accent-success'
                  : 'bg-bg-subtle border-border-subtle text-text-secondary hover:bg-bg-elevated'
              )}
            >
              <div className="font-medium text-sm sm:text-base">Enabled</div>
              <div className="text-xs sm:text-sm opacity-70 mt-0.5 sm:mt-1">
                Enforce airtime limits for regulatory compliance
              </div>
            </button>
            <button
              onClick={() => setDutyCycle(false)}
              className={clsx(
                'w-full p-3 sm:p-4 rounded-lg border text-left transition-all duration-200 min-h-[64px]',
                !dutyCycleEnabled
                  ? 'bg-accent-secondary/20 border-accent-secondary/50 text-accent-secondary'
                  : 'bg-bg-subtle border-border-subtle text-text-secondary hover:bg-bg-elevated'
              )}
            >
              <div className="font-medium text-sm sm:text-base">Disabled</div>
              <div className="text-xs sm:text-sm opacity-70 mt-0.5 sm:mt-1">
                No airtime limiting (use with caution)
              </div>
            </button>
          </div>
          </Card>
        </GridCell>

        {/* Radio Configuration */}
        <GridCell md={6}>
          <Card>
            <div ref={radioCardRef}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium text-text-primary flex items-center gap-2">
              <Antenna className="w-5 h-5 text-accent-primary" />
              Radio Configuration
            </h2>
            <div className="flex items-center gap-1">
              {radioConfig && (
                isEditing ? (
                  <>
                    <button
                      onClick={cancelEditing}
                      disabled={isSaving}
                      className={clsx(
                        'p-2 rounded-lg transition-colors',
                        isSaving 
                          ? 'text-text-muted cursor-not-allowed' 
                          : 'text-text-muted hover:text-accent-danger hover:bg-accent-danger/10'
                      )}
                      title="Cancel"
                    >
                      <X className="w-4 h-4" />
                    </button>
                    <button
                      onClick={handleSave}
                      disabled={isSaving || !hasChanges}
                      className={clsx(
                        'p-2 rounded-lg transition-colors',
                        isSaving 
                          ? 'text-accent-primary cursor-wait'
                          : hasChanges 
                            ? 'text-accent-success hover:bg-accent-success/10' 
                            : 'text-text-muted cursor-not-allowed'
                      )}
                      title={hasChanges ? 'Save changes' : 'No changes to save'}
                    >
                      {isSaving ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Check className="w-4 h-4" />
                      )}
                    </button>
                  </>
                ) : (
                  <button
                    onClick={startEditing}
                    className="p-2 rounded-lg transition-colors text-text-muted hover:text-text-primary hover:bg-bg-subtle"
                    title="Edit radio settings"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                )
              )}
            </div>
          </div>
          
          {saveResult && (
            <div className={clsx(
              'text-xs mb-3 px-2 py-1.5 rounded-md',
              saveResult.success 
                ? 'text-accent-success bg-accent-success/10' 
                : 'text-accent-danger bg-accent-danger/10'
            )}>
              {saveResult.message}
            </div>
          )}
          
          {radioConfig ? (
            isEditing ? (
              <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm text-text-muted block mb-1">Frequency (MHz)</label>
                    <input
                      type="number"
                      value={formFrequency}
                      onChange={(e) => setFormFrequency(e.target.value)}
                      step="0.001"
                      min="400"
                      max="930"
                      className="w-full h-[38px] bg-bg-subtle border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
                    />
                  </div>

                  <div>
                    <label className="text-sm text-text-muted block mb-1">TX Power (dBm)</label>
                    <input
                      type="number"
                      value={formTxPower}
                      onChange={(e) => setFormTxPower(e.target.value)}
                      min="-9"
                      max="22"
                      className="w-full h-[38px] bg-bg-subtle border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
                    />
                  </div>

                  <div>
                    <label className="text-sm text-text-muted block mb-1">Bandwidth</label>
                    <div className="relative">
                      <select
                        value={formBandwidth}
                        onChange={(e) => setFormBandwidth(parseFloat(e.target.value))}
                        className="w-full h-[38px] bg-bg-subtle border border-border-subtle rounded-lg px-3 pr-8 py-2 text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/50 appearance-none cursor-pointer"
                      >
                        {BANDWIDTHS.map((bw) => (
                          <option key={bw.value} value={bw.value}>
                            {bw.label}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" />
                    </div>
                  </div>

                  <div>
                    <label className="text-sm text-text-muted block mb-1">Spreading Factor</label>
                    <div className="relative">
                      <select
                        value={formSF}
                        onChange={(e) => setFormSF(parseInt(e.target.value))}
                        className="w-full h-[38px] bg-bg-subtle border border-border-subtle rounded-lg px-3 pr-8 py-2 text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/50 appearance-none cursor-pointer"
                      >
                        {SPREADING_FACTORS.map((sf) => (
                          <option key={sf} value={sf}>
                            SF{sf}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" />
                    </div>
                  </div>

                  <div>
                    <label className="text-sm text-text-muted block mb-1">Coding Rate</label>
                    <div className="relative">
                      <select
                        value={formCR}
                        onChange={(e) => setFormCR(parseInt(e.target.value))}
                        className="w-full h-[38px] bg-bg-subtle border border-border-subtle rounded-lg px-3 pr-8 py-2 text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/50 appearance-none cursor-pointer"
                      >
                        {CODING_RATES.map((cr) => (
                          <option key={cr.value} value={cr.value}>
                            {cr.label}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" />
                    </div>
                  </div>

                  <div>
                    <label className="text-sm text-text-muted block mb-1">Preamble</label>
                    <p className="text-text-primary font-medium h-[38px] flex items-center">
                      {radioConfig.preamble_length} symbols
                    </p>
                  </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-text-muted block mb-1">Frequency</label>
                  <p className="text-text-primary font-medium h-[38px] flex items-center">
                    {formatFrequency(radioConfig.frequency)}
                  </p>
                </div>
                <div>
                  <label className="text-sm text-text-muted block mb-1">TX Power</label>
                  <p className="text-text-primary font-medium h-[38px] flex items-center">
                    {radioConfig.tx_power} dBm
                  </p>
                </div>
                <div>
                  <label className="text-sm text-text-muted block mb-1">Bandwidth</label>
                  <p className="text-text-primary font-medium h-[38px] flex items-center">
                    {formatBandwidth(radioConfig.bandwidth)}
                  </p>
                </div>
                <div>
                  <label className="text-sm text-text-muted block mb-1">Spreading Factor</label>
                  <p className="text-text-primary font-medium h-[38px] flex items-center">
                    SF{radioConfig.spreading_factor}
                  </p>
                </div>
                <div>
                  <label className="text-sm text-text-muted block mb-1">Coding Rate</label>
                  <p className="text-text-primary font-medium h-[38px] flex items-center">
                    4/{radioConfig.coding_rate}
                  </p>
                </div>
                <div>
                  <label className="text-sm text-text-muted block mb-1">Preamble Length</label>
                  <p className="text-text-primary font-medium h-[38px] flex items-center">
                    {radioConfig.preamble_length} symbols
                  </p>
                </div>
              </div>
            )
          ) : (
            <p className="text-text-muted">Loading radio configuration...</p>
          )}
            </div>
          </Card>
        </GridCell>

        {/* Location */}
        <GridCell md={6}>
          <Card>
          <h2 className="text-lg font-medium text-text-primary mb-4 flex items-center gap-2">
            <MapPin className="w-5 h-5 text-accent-primary" />
            Location
          </h2>
          {repeaterConfig ? (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-text-muted">Latitude</label>
                <p className="text-text-primary font-medium mt-1">
                  {repeaterConfig.latitude !== 0 ? repeaterConfig.latitude.toFixed(6) : 'Not set'}
                </p>
              </div>
              <div>
                <label className="text-sm text-text-muted">Longitude</label>
                <p className="text-text-primary font-medium mt-1">
                  {repeaterConfig.longitude !== 0 ? repeaterConfig.longitude.toFixed(6) : 'Not set'}
                </p>
              </div>
              <div>
                <label className="text-sm text-text-muted">Advert Interval</label>
                <p className="text-text-primary font-medium mt-1">
                  {repeaterConfig.send_advert_interval_hours > 0 
                    ? `${repeaterConfig.send_advert_interval_hours}h` 
                    : 'Disabled'}
                </p>
              </div>
              <div>
                <label className="text-sm text-text-muted">Score-based TX</label>
                <p className="text-text-primary font-medium mt-1">
                  {repeaterConfig.use_score_for_tx ? 'Enabled' : 'Disabled'}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-text-muted">Loading location settings...</p>
          )}
          </Card>
        </GridCell>

        {/* Node Information */}
        <GridCell>
          <Card>
          <h2 className="type-subheading text-text-primary mb-4 flex items-center gap-2">
            <Radio className="w-5 h-5 text-accent-primary" />
            Node Information
          </h2>
          {stats ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <span className="type-label text-text-muted">Node Name</span>
                  <p className="type-body text-text-primary mt-1">{nodeName}</p>
                </div>
                <div>
                  <span className="type-label text-text-muted">Version</span>
                  <p className="type-data text-text-primary mt-1">v{stats.version}</p>
                </div>
                <div>
                  <span className="type-label text-text-muted">Core Version</span>
                  <p className="type-data text-text-primary mt-1">v{stats.core_version}</p>
                </div>
                <div>
                  <span className="type-label text-text-muted">Local Hash</span>
                  <div className="mt-1">
                    {stats.local_hash ? (
                      <HashBadge hash={stats.local_hash} size="sm" />
                    ) : (
                      <span className="type-data-sm text-text-muted">N/A</span>
                    )}
                  </div>
                </div>
              </div>
              {stats.public_key && (
                <div className="mt-4 pt-4 border-t border-border-subtle">
                  <span className="type-label text-text-muted">Public Key</span>
                  <div className="mt-1">
                    <HashBadge hash={stats.public_key} prefixLength={12} suffixLength={8} />
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-text-muted">Loading node information...</p>
          )}
          </Card>
        </GridCell>
      </Grid12>
    </PageContainer>
  );
}
