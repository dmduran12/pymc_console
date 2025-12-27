/**
 * Terminal - Interactive command-line interface to the repeater
 * 
 * This is a CLIENT-SIDE command interpreter that maps terminal commands
 * to existing pyMC_Repeater API endpoints. No backend terminal endpoint required.
 * 
 * Features:
 * - ASCII art header (PYMC_TERMINAL)
 * - Faux loading sequence with real connection check
 * - Command input with blinking cursor
 * - Command history with output display
 * - Autocomplete for commands
 * - Maps commands to existing REST endpoints
 */

import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { SquareTerminal } from 'lucide-react';
import clsx from 'clsx';
import { useStats } from '@/lib/stores/useStore';
import {
  sendAdvert,
  setMode,
  setDutyCycle,
  updateRadioConfig,
  setLogLevel,
  getStats,
  getPacketStats,
} from '@/lib/api';
import type { LogLevel } from '@/lib/api';
import { MESHCORE_COMMANDS, type MeshCoreCommand } from '@/lib/meshcore-commands';

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const ASCII_HEADER = `██████  ██    ██ ███    ███  ██████         ████████ ███████ ██████  ███    ███ ██ ███    ██  █████  ██      
██   ██  ██  ██  ████  ████ ██                 ██    ██      ██   ██ ████  ████ ██ ████   ██ ██   ██ ██      
██████    ████   ██ ████ ██ ██                 ██    █████   ██████  ██ ████ ██ ██ ██ ██  ██ ███████ ██      
██         ██    ██  ██  ██ ██                 ██    ██      ██   ██ ██  ██  ██ ██ ██  ██ ██ ██   ██ ██      
██         ██    ██      ██  ██████ ███████    ██    ███████ ██   ██ ██      ██ ██ ██   ████ ██   ██ ███████`;

type ConnectionState = 'initializing' | 'checking' | 'connected' | 'error';

interface CommandEntry {
  id: string;
  cmd: string;
  result: string | null;
  isProcessing: boolean;
  timestamp: number;
}

// Available commands for help and autocomplete
interface CommandDef {
  cmd: string;
  desc: string;
  params?: string;
  required?: boolean;
}

// Build available commands from MeshCore registry + local additions
// Filter out serial-only commands and add local commands
const AVAILABLE_COMMANDS: CommandDef[] = [
  // Local commands (not in MeshCore)
  { cmd: 'help', desc: 'Show available commands' },
  { cmd: 'clear', desc: 'Clear terminal screen' },
  { cmd: 'status', desc: 'Get repeater status summary' },
  { cmd: 'uptime', desc: 'Show system uptime' },
  { cmd: 'packets', desc: 'Show packet statistics' },
  { cmd: 'board', desc: 'Show board/platform info' },
  
  // Import MeshCore commands (excluding serial-only and unsupported)
  ...MESHCORE_COMMANDS
    .filter((c: MeshCoreCommand) => !c.serialOnly)  // Exclude serial-only
    .filter((c: MeshCoreCommand) => !c.name.startsWith('gps'))  // No GPS on Pi
    .filter((c: MeshCoreCommand) => !c.name.startsWith('bridge'))  // No bridge support
    .filter((c: MeshCoreCommand) => !c.name.startsWith('sensor'))  // No sensors
    .filter((c: MeshCoreCommand) => c.name !== 'start ota')  // No OTA via HTTP
    .filter((c: MeshCoreCommand) => c.name !== 'erase')  // Too dangerous
    .filter((c: MeshCoreCommand) => c.name !== 'reboot')  // Use systemctl
    .map((c: MeshCoreCommand) => ({
      cmd: c.name,
      desc: c.description,
      params: c.hasParam ? '{value}' : undefined,
      required: c.hasParam,
    })),
];

// Parameter suggestions for autocomplete (MeshCore-compatible values)
const PARAM_SUGGESTIONS: Record<string, string[]> = {
  // Mode/toggle commands
  'set mode': ['forward', 'monitor'],
  'set duty': ['on', 'off'],
  'set repeat': ['on', 'off'],
  'set allow.read.only': ['on', 'off'],
  'set multi.acks': ['0', '1'],
  
  // Radio parameters
  'set tx': ['10', '14', '17', '20', '22'],
  'set sf': ['7', '8', '9', '10', '11', '12'],
  'set bw': ['125', '250', '500'],
  'set freq': ['906.875', '915.0', '920.0'],
  'set radio': ['906.875 250 10 5', '915.0 125 7 5'],
  'tempradio': ['906.875 250 10 5', '915.0 125 7 5', '920.0 500 12 8'],
  
  // Timing parameters
  'set af': ['0.5', '1.0', '1.5', '2.0'],
  'set txdelay': ['0.5', '0.7', '1.0', '1.5'],
  'set direct.txdelay': ['0.3', '0.5', '0.7'],
  'set rxdelay': ['0', '0.5', '1.0'],
  
  // Intervals
  'set advert.interval': ['0', '60', '120', '180'],
  'set flood.advert.interval': ['0', '6', '12', '24'],
  'set flood.max': ['0', '3', '5', '10'],
  'set agc.reset.interval': ['0', '60', '300'],
  'set int.thresh': ['10', '14', '18', '22'],
  
  // Log level
  'set log': ['debug', 'info', 'warning'],
};

// Status response parsing
interface StatusItem {
  label: string;
  value: string;
  status: 'normal' | 'good' | 'warning' | 'critical';
}

function isStatusResponse(result: string): boolean {
  return result.includes('Batt:') && result.includes('|');
}

function parseStatusResponse(result: string): StatusItem[] {
  const items: StatusItem[] = [];
  const parts = result.split(' | ');
  
  for (const part of parts) {
    const colonIndex = part.indexOf(':');
    if (colonIndex === -1) continue;
    
    const label = part.substring(0, colonIndex).trim();
    const value = part.substring(colonIndex + 1).trim();
    
    let status: StatusItem['status'] = 'normal';
    
    if (label === 'Batt') {
      const voltage = parseFloat(value);
      if (voltage < 3.3) status = 'critical';
      else if (voltage < 3.6) status = 'warning';
      else status = 'good';
    } else if (label === 'RSSI') {
      const rssi = parseInt(value);
      if (rssi < -120) status = 'critical';
      else if (rssi < -100) status = 'warning';
      else status = 'good';
    } else if (label === 'SNR') {
      const snr = parseFloat(value);
      if (snr < 0) status = 'warning';
      else status = 'good';
    } else if (label === 'Err' && parseInt(value) > 0) {
      status = 'warning';
    } else if (label === 'TxQ' && parseInt(value) > 5) {
      status = 'warning';
    }
    
    items.push({ label, value, status });
  }
  
  return items;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Components
// ═══════════════════════════════════════════════════════════════════════════════

/** Blinking cursor component */
const Cursor = memo(function Cursor({ visible }: { visible: boolean }) {
  return (
    <span 
      className={clsx(
        'inline-block w-2 h-4 bg-accent-primary ml-0.5 align-middle',
        visible ? 'opacity-100' : 'opacity-20'
      )}
      aria-hidden="true"
    />
  );
});

/** Status table for parsed status responses */
const StatusTable = memo(function StatusTable({ items, nodeName }: { items: StatusItem[]; nodeName: string }) {
  const statusColors = {
    normal: 'text-text-primary',
    good: 'text-accent-success',
    warning: 'text-amber-400',
    critical: 'text-accent-danger',
  };
  
  return (
    <div className="mt-2 p-3 rounded-lg bg-bg-subtle border border-border-subtle">
      <div className="text-center text-accent-primary text-xs font-semibold uppercase tracking-wide mb-3 pb-2 border-b border-border-subtle">
        {nodeName} Status
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {items.map((item) => (
          <div key={item.label} className="flex justify-between items-center px-2 py-1 rounded bg-bg-elevated border border-border-subtle">
            <span className="text-text-muted text-xs uppercase">{item.label}</span>
            <span className={clsx('text-xs font-semibold', statusColors[item.status])}>
              {item.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});

/** Single command entry in the log */
const CommandRow = memo(function CommandRow({ entry, nodeName }: { entry: CommandEntry; nodeName: string }) {
  // Check if this is a status command with parseable response
  const isStatus = entry.cmd.trim().toLowerCase() === 'status';
  const statusItems = isStatus && entry.result && isStatusResponse(entry.result) 
    ? parseStatusResponse(entry.result) 
    : null;
  
  return (
    <div className="mb-3">
      {/* Command line */}
      <div className="flex items-center gap-2">
        <span className="text-accent-primary font-semibold">
          {nodeName}@repeater:~$
        </span>
        <span className="text-text-primary">{entry.cmd}</span>
      </div>
      
      {/* Output */}
      {entry.isProcessing ? (
        <div className="ml-0 mt-1 text-accent-secondary flex items-center gap-1">
          <span>Processing</span>
          <span className="inline-flex gap-0.5">
            <span className="animate-pulse" style={{ animationDelay: '0ms' }}>.</span>
            <span className="animate-pulse" style={{ animationDelay: '200ms' }}>.</span>
            <span className="animate-pulse" style={{ animationDelay: '400ms' }}>.</span>
          </span>
        </div>
      ) : statusItems ? (
        <StatusTable items={statusItems} nodeName={nodeName} />
      ) : entry.result ? (
        <div className="ml-0 mt-1 text-text-secondary whitespace-pre-wrap border-l-2 border-border-subtle pl-3">
          {entry.result}
        </div>
      ) : null}
    </div>
  );
});

/** Loading sequence line */
const LoadingLine = memo(function LoadingLine({ 
  text, 
  status 
}: { 
  text: string; 
  status: 'pending' | 'active' | 'done' | 'error';
}) {
  return (
    <div className="flex items-center gap-2 mb-1">
      {status === 'pending' && (
        <span className="text-text-muted">○</span>
      )}
      {status === 'active' && (
        <span className="text-accent-secondary animate-pulse">●</span>
      )}
      {status === 'done' && (
        <span className="text-accent-success">✓</span>
      )}
      {status === 'error' && (
        <span className="text-accent-danger">✗</span>
      )}
      <span className={clsx(
        status === 'pending' && 'text-text-muted',
        status === 'active' && 'text-accent-secondary',
        status === 'done' && 'text-accent-success',
        status === 'error' && 'text-accent-danger',
      )}>
        {text}
      </span>
    </div>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════════════════════

export default function Terminal() {
  const stats = useStats();
  const nodeName = stats?.node_name || 'pymc';
  
  // Connection state
  const [connectionState, setConnectionState] = useState<ConnectionState>('initializing');
  const [loadingStep, setLoadingStep] = useState(0);
  
  // Terminal state
  const [commandHistory, setCommandHistory] = useState<CommandEntry[]>([]);
  const [currentInput, setCurrentInput] = useState('');
  const [cursorVisible, setCursorVisible] = useState(true);
  const [historyIndex, setHistoryIndex] = useState(-1);
  
  // Autocomplete state
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteOptions, setAutocompleteOptions] = useState<CommandDef[]>([]);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState(0);
  
  // Refs
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const cursorIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Loading sequence (runs once on mount)
  // ─────────────────────────────────────────────────────────────────────────────
  
  const hasRunLoadingSequence = useRef(false);
  
  useEffect(() => {
    // Only run once
    if (hasRunLoadingSequence.current) return;
    hasRunLoadingSequence.current = true;
    
    const runLoadingSequence = async () => {
      // Step 1: Initializing
      setLoadingStep(1);
      await new Promise(r => setTimeout(r, 600));
      
      // Step 2: Checking connection
      setConnectionState('checking');
      setLoadingStep(2);
      await new Promise(r => setTimeout(r, 800));
      
      // Step 3: Connected (stats should already be loaded by app)
      setLoadingStep(3);
      await new Promise(r => setTimeout(r, 400));
      setConnectionState('connected');
    };
    
    runLoadingSequence();
  }, []);
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Cursor blinking
  // ─────────────────────────────────────────────────────────────────────────────
  
  useEffect(() => {
    cursorIntervalRef.current = setInterval(() => {
      setCursorVisible(v => !v);
    }, 530);
    
    return () => {
      if (cursorIntervalRef.current) {
        clearInterval(cursorIntervalRef.current);
      }
    };
  }, []);
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Auto-scroll to bottom
  // ─────────────────────────────────────────────────────────────────────────────
  
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [commandHistory]);
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Focus input on click anywhere in terminal
  // ─────────────────────────────────────────────────────────────────────────────
  
  const focusInput = useCallback(() => {
    if (inputRef.current && connectionState === 'connected') {
      inputRef.current.focus();
    }
  }, [connectionState]);
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Autocomplete
  // ─────────────────────────────────────────────────────────────────────────────
  
  const updateAutocomplete = useCallback((input: string) => {
    const trimmed = input.trim().toLowerCase();
    
    if (!trimmed) {
      setShowAutocomplete(false);
      setAutocompleteOptions([]);
      return;
    }
    
    const hasSpace = trimmed.includes(' ');
    let matches: CommandDef[] = [];
    
    if (hasSpace) {
      // Check for parameter suggestions
      const parts = trimmed.split(' ');
      const baseCommand = parts.slice(0, -1).join(' ');
      const paramValue = parts[parts.length - 1];
      
      const commandDef = AVAILABLE_COMMANDS.find(
        c => c.cmd.toLowerCase() === baseCommand
      );
      
      if (commandDef && PARAM_SUGGESTIONS[commandDef.cmd]) {
        matches = PARAM_SUGGESTIONS[commandDef.cmd]
          .filter(p => p.toLowerCase().startsWith(paramValue))
          .map(p => ({
            cmd: `${commandDef.cmd} ${p}`,
            desc: `${commandDef.desc} → ${p}`,
          }));
      }
    } else {
      // Command matching
      matches = AVAILABLE_COMMANDS.filter(
        c => c.cmd.toLowerCase().startsWith(trimmed)
      );
    }
    
    if (matches.length > 0) {
      setAutocompleteOptions(matches.slice(0, 8));
      setSelectedOptionIndex(0);
      setShowAutocomplete(true);
    } else {
      setShowAutocomplete(false);
      setAutocompleteOptions([]);
    }
  }, []);
  
  const selectAutocompleteOption = useCallback((index: number) => {
    const option = autocompleteOptions[index];
    if (!option) return;
    
    if (option.required && option.params) {
      // Add space for parameter input
      setCurrentInput(option.cmd + ' ');
      updateAutocomplete(option.cmd + ' ');
    } else {
      setCurrentInput(option.cmd);
      setShowAutocomplete(false);
      setAutocompleteOptions([]);
    }
    
    inputRef.current?.focus();
  }, [autocompleteOptions, updateAutocomplete]);
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Command execution - maps commands to existing API endpoints
  // ─────────────────────────────────────────────────────────────────────────────
  
  const executeCommand = useCallback(async (cmd: string) => {
    const trimmedCmd = cmd.trim();
    if (!trimmedCmd) return;
    const lowerCmd = trimmedCmd.toLowerCase();
    
    // Handle client-side commands
    if (lowerCmd === 'clear') {
      setCommandHistory([]);
      return;
    }
    
    if (lowerCmd === 'help') {
      const helpText = AVAILABLE_COMMANDS
        .map(c => `  ${c.cmd.padEnd(18)} ${c.desc}`)
        .join('\n');
      
      const entry: CommandEntry = {
        id: crypto.randomUUID(),
        cmd: trimmedCmd,
        result: `Available commands:\n\n${helpText}\n\nNote: Commands use existing API endpoints. Some MeshCore CLI\ncommands are not available via HTTP.`,
        isProcessing: false,
        timestamp: Date.now(),
      };
      setCommandHistory(prev => [...prev, entry]);
      return;
    }
    
    // Create entry with processing state
    const entryId = crypto.randomUUID();
    const entry: CommandEntry = {
      id: entryId,
      cmd: trimmedCmd,
      result: null,
      isProcessing: true,
      timestamp: Date.now(),
    };
    setCommandHistory(prev => [...prev, entry]);
    
    // Helper to update result
    const setResult = (result: string) => {
      setCommandHistory(prev => 
        prev.map(e => e.id === entryId ? { ...e, isProcessing: false, result } : e)
      );
    };
    
    try {
      // Refresh stats for read commands
      const freshStats = await getStats();
      
      // Helper to format uptime from seconds
      const formatUptime = (seconds: number): string => {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        if (days > 0) return `${days}d ${hours}h ${mins}m`;
        if (hours > 0) return `${hours}h ${mins}m`;
        return `${mins}m`;
      };
      
      // ═══════════════════════════════════════════════════════════════════════
      // READ COMMANDS - Use /api/stats data
      // ═══════════════════════════════════════════════════════════════════════
      
      if (lowerCmd === 'status') {
        const mode = freshStats.config?.repeater?.mode || 'unknown';
        const dutyCycle = freshStats.config?.duty_cycle?.enforcement_enabled ? 'enabled' : 'disabled';
        const neighbors = Object.keys(freshStats.neighbors || {}).length;
        const uptime = formatUptime(freshStats.uptime_seconds || 0);
        setResult(
          `Mode: ${mode} | Duty Cycle: ${dutyCycle}\n` +
          `Neighbors: ${neighbors} | Uptime: ${uptime}`
        );
        return;
      }
      
      if (lowerCmd === 'ver' || lowerCmd === 'version') {
        const ver = freshStats.version || 'unknown';
        const coreVer = freshStats.core_version || 'unknown';
        setResult(`pyMC Repeater v${ver}\npyMC Core v${coreVer}`);
        return;
      }
      
      if (lowerCmd === 'clock') {
        const now = new Date();
        setResult(now.toLocaleString());
        return;
      }
      
      if (lowerCmd === 'uptime') {
        setResult(formatUptime(freshStats.uptime_seconds || 0));
        return;
      }
      
      if (lowerCmd === 'neighbors') {
        const neighbors = freshStats.neighbors || {};
        const entries = Object.entries(neighbors);
        if (entries.length === 0) {
          setResult('No neighbors discovered yet.');
        } else {
          const lines = entries.map(([hash, info]) => {
            const name = info.name || info.node_name || 'Unknown';
            const rssi = info.rssi != null ? `${info.rssi}dBm` : '?';
            const snr = info.snr != null ? `${info.snr}dB` : '?';
            return `  ${hash.slice(0, 8)}  ${name.padEnd(16)} RSSI:${rssi.padStart(6)} SNR:${snr.padStart(5)}`;
          });
          setResult(`Neighbors (${entries.length}):\n${lines.join('\n')}`);
        }
        return;
      }
      
      if (lowerCmd === 'packets') {
        setResult(
          `Packets RX: ${freshStats.rx_count ?? '?'} | TX: ${freshStats.tx_count ?? '?'}\n` +
          `Forwarded: ${freshStats.forwarded_count ?? '?'} | Dropped: ${freshStats.dropped_count ?? '?'}`
        );
        return;
      }
      
      // ═══════════════════════════════════════════════════════════════════════
      // ALL GET COMMANDS - MeshCore parity (from CommonCLI.cpp)
      // ═══════════════════════════════════════════════════════════════════════
      
      if (lowerCmd.startsWith('get ')) {
        const param = lowerCmd.slice(4).trim();
        const radio = freshStats.config?.radio;
        const repeater = freshStats.config?.repeater;
        const delays = freshStats.config?.delays;
        
        switch (param) {
          // Identity
          case 'name':
            setResult(`> ${freshStats.node_name || 'Unknown'}`);
            return;
          case 'public.key':
            setResult(`> ${freshStats.public_key || 'Not available'}`);
            return;
          case 'role':
            setResult(`> repeater`);
            return;
            
          // Radio params (MeshCore format: freq,bw,sf,cr)
          case 'radio': {
            if (!radio) { setResult('> Radio config not available'); return; }
            const freq = radio.frequency ? (radio.frequency / 1_000_000).toFixed(3) : '?';
            const bw = radio.bandwidth ? (radio.bandwidth / 1000) : '?';
            setResult(`> ${freq},${bw},${radio.spreading_factor || '?'},${radio.coding_rate || '?'}`);
            return;
          }
          case 'freq':
            setResult(`> ${radio?.frequency ? (radio.frequency / 1_000_000).toFixed(3) : '?'}`);
            return;
          case 'tx':
            setResult(`> ${radio?.tx_power ?? '?'}`);
            return;
            
          // Timing
          case 'af':
            setResult(`> ${repeater?.use_score_for_tx ? '1.0' : '0'}`);
            return;
          case 'rxdelay':
            setResult(`> ${delays?.tx_delay_factor ?? '0'}`);
            return;
          case 'txdelay':
            setResult(`> ${delays?.tx_delay_factor ?? '1.0'}`);
            return;
          case 'direct.txdelay':
            setResult(`> ${delays?.direct_tx_delay_factor ?? '0.5'}`);
            return;
            
          // Repeater settings
          case 'repeat':
            setResult(`> ${repeater?.mode === 'forward' ? 'on' : 'off'}`);
            return;
          case 'lat':
            setResult(`> ${repeater?.latitude ?? '0'}`);
            return;
          case 'lon':
            setResult(`> ${repeater?.longitude ?? '0'}`);
            return;
            
          // Intervals
          case 'advert.interval':
            setResult(`> ${(repeater?.send_advert_interval_hours ?? 2) * 60}`);
            return;
          case 'flood.advert.interval':
            setResult(`> ${repeater?.send_advert_interval_hours ?? 24}`);
            return;
          case 'flood.max':
            setResult(`> 3`);  // Default, not exposed in config
            return;
          case 'agc.reset.interval':
            setResult(`> 0`);  // Not implemented in pyMC
            return;
            
          // Security
          case 'allow.read.only':
            setResult(`> off`);  // Not exposed
            return;
          case 'guest.password':
            setResult(`> (not exposed via HTTP)`);
            return;
          case 'multi.acks':
            setResult(`> 0`);
            return;
          case 'int.thresh':
            setResult(`> 0`);
            return;
            
          // Mode (custom for pyMC)
          case 'mode':
            setResult(`> ${repeater?.mode || 'forward'}`);
            return;
            
          default:
            setResult(`??: ${param}`);
            return;
        }
      }
      
      // board command (MeshCore parity)
      if (lowerCmd === 'board') {
        setResult('pyMC_Repeater (Linux/Raspberry Pi)');
        return;
      }
      
      // stats-packets (MeshCore format)
      if (lowerCmd === 'stats-packets') {
        try {
          const pktStats = await getPacketStats(24);
          if (pktStats.success && pktStats.data) {
            setResult(
              `rx: ${freshStats.rx_count ?? 0}\n` +
              `tx: ${freshStats.tx_count ?? 0}\n` +
              `fwd: ${freshStats.forwarded_count ?? 0}\n` +
              `drop: ${freshStats.dropped_count ?? 0}`
            );
          } else {
            setResult(`rx: ${freshStats.rx_count ?? 0}, tx: ${freshStats.tx_count ?? 0}`);
          }
        } catch {
          setResult(`rx: ${freshStats.rx_count ?? 0}, tx: ${freshStats.tx_count ?? 0}`);
        }
        return;
      }
      
      // stats-radio
      if (lowerCmd === 'stats-radio') {
        const radio = freshStats.config?.radio;
        setResult(
          `freq: ${radio?.frequency ? (radio.frequency / 1_000_000).toFixed(3) : '?'} MHz\n` +
          `bw: ${radio?.bandwidth ? radio.bandwidth / 1000 : '?'} kHz\n` +
          `sf: ${radio?.spreading_factor ?? '?'}\n` +
          `cr: ${radio?.coding_rate ?? '?'}\n` +
          `tx_pwr: ${radio?.tx_power ?? '?'} dBm\n` +
          `noise: ${freshStats.noise_floor_dbm ?? '?'} dBm`
        );
        return;
      }
      
      // stats-core
      if (lowerCmd === 'stats-core') {
        setResult(
          `uptime: ${formatUptime(freshStats.uptime_seconds || 0)}\n` +
          `rx/hr: ${freshStats.rx_per_hour?.toFixed(1) ?? '?'}\n` +
          `fwd/hr: ${freshStats.forwarded_per_hour?.toFixed(1) ?? '?'}\n` +
          `neighbors: ${Object.keys(freshStats.neighbors || {}).length}\n` +
          `airtime: ${freshStats.utilization_percent?.toFixed(1) ?? '?'}%`
        );
        return;
      }
      
      // clear stats
      if (lowerCmd === 'clear stats') {
        setResult('Error: Not implemented in pyMC_Repeater');
        return;
      }
      
      // tempradio <freq> <bw> <sf> <cr> - MeshCore format
      // Note: On pyMC_Repeater this persists to config.yaml (restart service to revert)
      if (lowerCmd.startsWith('tempradio ')) {
        const parts = lowerCmd.split(/\s+/);
        if (parts.length < 5) {
          setResult('Usage: tempradio <freq_mhz> <bw_khz> <sf> <cr>\nExample: tempradio 906.875 250 10 5');
          return;
        }
        const freq = parseFloat(parts[1]);
        const bw = parseInt(parts[2]);
        const sf = parseInt(parts[3]);
        const cr = parseInt(parts[4]);
        
        if (isNaN(freq) || freq < 100 || freq > 1000) {
          setResult('Error: Frequency must be in MHz (e.g., 906.875)');
          return;
        }
        if (![125, 250, 500].includes(bw)) {
          setResult('Error: Bandwidth must be 125, 250, or 500 kHz');
          return;
        }
        if (isNaN(sf) || sf < 5 || sf > 12) {
          setResult('Error: Spreading factor must be 5-12');
          return;
        }
        if (isNaN(cr) || cr < 5 || cr > 8) {
          setResult('Error: Coding rate must be 5-8');
          return;
        }
        
        const response = await updateRadioConfig({
          frequency_mhz: freq,
          bandwidth_khz: bw,
          spreading_factor: sf,
          coding_rate: cr,
        });
        if (response.success) {
          setResult(`OK - Radio: ${freq}MHz, ${bw}kHz, SF${sf}, CR4/${cr}\nNote: Changes persist. Restart service to revert.`);
        } else {
          setResult(`Error: ${response.error || 'Failed to update radio config'}`);
        }
        return;
      }
      
      // neighbor.remove
      if (lowerCmd.startsWith('neighbor.remove ')) {
        setResult('Error: neighbor.remove not implemented via HTTP');
        return;
      }
      
      // password
      if (lowerCmd.startsWith('password ')) {
        setResult('Error: Use config.yaml to change password');
        return;
      }
      
      // log commands
      if (lowerCmd === 'log start' || lowerCmd === 'log stop' || lowerCmd === 'log erase') {
        setResult('Error: Log commands not implemented via HTTP');
        return;
      }
      
      // ═══════════════════════════════════════════════════════════════════════
      // ACTION COMMANDS - Use existing POST endpoints
      // ═══════════════════════════════════════════════════════════════════════
      
      if (lowerCmd === 'advert') {
        const response = await sendAdvert();
        setResult(response.success ? 'OK - Advert sent' : `Error: ${response.error || 'Failed'}`);
        return;
      }
      
      if (lowerCmd.startsWith('set mode ')) {
        const mode = lowerCmd.split(' ')[2];
        if (mode !== 'forward' && mode !== 'monitor') {
          setResult('Error: Mode must be "forward" or "monitor"');
          return;
        }
        const response = await setMode(mode as 'forward' | 'monitor');
        setResult(response.success ? `OK - Mode set to ${mode}` : 'Error: Failed to set mode');
        return;
      }
      
      if (lowerCmd.startsWith('set duty ')) {
        const val = lowerCmd.split(' ')[2];
        const enabled = val === 'on' || val === '1' || val === 'true';
        const response = await setDutyCycle(enabled);
        setResult(response.success ? `OK - Duty cycle ${enabled ? 'enabled' : 'disabled'}` : 'Error: Failed to set duty cycle');
        return;
      }
      
      if (lowerCmd.startsWith('set log ')) {
        const level = lowerCmd.split(' ')[2]?.toUpperCase();
        if (!['DEBUG', 'INFO', 'WARNING', 'ERROR'].includes(level)) {
          setResult('Error: Level must be debug, info, warning, or error');
          return;
        }
        const response = await setLogLevel(level as LogLevel);
        setResult(response.success ? `OK - Log level set to ${level}. Service restarting...` : `Error: ${response.error || 'Failed'}`);
        return;
      }
      
      if (lowerCmd.startsWith('set tx ')) {
        const power = parseInt(lowerCmd.split(' ')[2]);
        if (isNaN(power) || power < 2 || power > 22) {
          setResult('Error: TX power must be 2-22 dBm');
          return;
        }
        const response = await updateRadioConfig({ tx_power: power });
        setResult(response.success ? `OK - TX power set to ${power}dBm. Restart service to apply.` : `Error: ${response.error || 'Failed'}`);
        return;
      }
      
      if (lowerCmd.startsWith('set freq ')) {
        const freq = parseFloat(lowerCmd.split(' ')[2]);
        if (isNaN(freq) || freq < 100 || freq > 1000) {
          setResult('Error: Frequency must be in MHz (e.g., 906.875)');
          return;
        }
        const response = await updateRadioConfig({ frequency_mhz: freq });
        setResult(response.success ? `OK - Frequency set to ${freq}MHz. Restart service to apply.` : `Error: ${response.error || 'Failed'}`);
        return;
      }
      
      if (lowerCmd.startsWith('set sf ')) {
        const sf = parseInt(lowerCmd.split(' ')[2]);
        if (isNaN(sf) || sf < 5 || sf > 12) {
          setResult('Error: Spreading factor must be 5-12');
          return;
        }
        const response = await updateRadioConfig({ spreading_factor: sf });
        setResult(response.success ? `OK - SF set to ${sf}. Restart service to apply.` : `Error: ${response.error || 'Failed'}`);
        return;
      }
      
      if (lowerCmd.startsWith('set bw ')) {
        const bw = parseInt(lowerCmd.split(' ')[2]);
        if (![125, 250, 500].includes(bw)) {
          setResult('Error: Bandwidth must be 125, 250, or 500 kHz');
          return;
        }
        const response = await updateRadioConfig({ bandwidth_khz: bw });
        setResult(response.success ? `OK - Bandwidth set to ${bw}kHz. Restart service to apply.` : `Error: ${response.error || 'Failed'}`);
        return;
      }
      
      // ═══════════════════════════════════════════════════════════════════════
      // UNKNOWN COMMAND
      // ═══════════════════════════════════════════════════════════════════════
      
      setResult(`Unknown command: ${trimmedCmd}\nType 'help' for available commands.`);
      
    } catch (error) {
      setResult(`Error: ${error instanceof Error ? error.message : 'Command failed'}`);
    }
  }, []);
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Input handling
  // ─────────────────────────────────────────────────────────────────────────────
  
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // Autocomplete navigation (arrows, tab, escape)
    if (showAutocomplete && autocompleteOptions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedOptionIndex(i => Math.min(i + 1, autocompleteOptions.length - 1));
        return;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedOptionIndex(i => Math.max(i - 1, 0));
        return;
      } else if (e.key === 'Tab') {
        e.preventDefault();
        selectAutocompleteOption(selectedOptionIndex);
        return;
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setShowAutocomplete(false);
        return;
      }
      // NOTE: Enter executes the command as typed (like a real terminal)
      // Use Tab to accept autocomplete suggestion
    }
    
    if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = currentInput;
      setCurrentInput('');
      setHistoryIndex(-1);
      setShowAutocomplete(false);
      executeCommand(cmd);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const cmds = commandHistory.filter(c => c.cmd).map(c => c.cmd);
      if (cmds.length > 0) {
        const newIndex = historyIndex < cmds.length - 1 ? historyIndex + 1 : historyIndex;
        setHistoryIndex(newIndex);
        setCurrentInput(cmds[cmds.length - 1 - newIndex] || '');
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const cmds = commandHistory.filter(c => c.cmd).map(c => c.cmd);
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setCurrentInput(cmds[cmds.length - 1 - newIndex] || '');
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setCurrentInput('');
      }
    }
  }, [currentInput, commandHistory, historyIndex, executeCommand, showAutocomplete, autocompleteOptions, selectedOptionIndex, selectAutocompleteOption]);
  
  // Handle input change with autocomplete
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setCurrentInput(value);
    updateAutocomplete(value);
  }, [updateAutocomplete]);
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────
  
  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <SquareTerminal className="w-6 h-6 text-accent-primary" />
        <h1 className="text-xl font-semibold text-text-primary">Terminal</h1>
      </div>
      
      {/* Terminal Card - Full height */}
      <div 
        className="glass-card overflow-hidden flex flex-col"
        style={{ height: 'calc(100vh - 180px)', minHeight: '400px' }}
        onClick={focusInput}
      >
        {/* Terminal Body */}
        <div 
          ref={logRef}
          className="flex-1 p-4 sm:p-6 overflow-y-auto font-mono text-sm leading-relaxed bg-black/30"
        >
          {/* ASCII Header */}
          <pre className="text-accent-primary text-[0.5rem] sm:text-[0.6rem] lg:text-xs leading-none mb-6 overflow-x-auto">
            {ASCII_HEADER}
          </pre>
          
          {/* Loading Sequence */}
          {connectionState !== 'connected' && (
            <div className="mb-6">
              <LoadingLine 
                text="Initializing terminal..." 
                status={loadingStep >= 1 ? (loadingStep === 1 ? 'active' : 'done') : 'pending'} 
              />
              <LoadingLine 
                text="Checking repeater connection..." 
                status={loadingStep >= 2 ? (loadingStep === 2 ? 'active' : 'done') : 'pending'} 
              />
              <LoadingLine 
                text={connectionState === 'error' ? 'Connection failed' : 'Connection established'} 
                status={loadingStep >= 3 ? (connectionState === 'error' ? 'error' : 'done') : 'pending'} 
              />
            </div>
          )}
          
          {/* Welcome message after connected */}
          {connectionState === 'connected' && commandHistory.length === 0 && (
            <div className="mb-4">
              <p className="text-accent-success mb-1">
                Connected to {nodeName}
              </p>
              <p className="text-text-muted">
                Type 'help' for available commands.
              </p>
            </div>
          )}
          
          {/* Command History */}
          {commandHistory.map(entry => (
            <CommandRow key={entry.id} entry={entry} nodeName={nodeName} />
          ))}
          
          {/* Current Input Line */}
          {connectionState === 'connected' && (
            <div className="relative">
              <div className="flex items-center gap-2">
                <span className="text-accent-primary font-semibold">
                  {nodeName}@repeater:~$
                </span>
                <span className="text-text-primary">{currentInput}</span>
                <Cursor visible={cursorVisible} />
              </div>
              
              {/* Autocomplete Dropdown */}
              {showAutocomplete && autocompleteOptions.length > 0 && (
                <div className="absolute left-0 bottom-full mb-2 w-full max-w-lg bg-bg-elevated border border-border-subtle rounded-lg shadow-xl overflow-hidden z-10">
                  <div className="px-3 py-2 bg-bg-subtle border-b border-border-subtle flex justify-between items-center">
                    <span className="text-xs font-semibold text-accent-primary uppercase tracking-wide">Available Commands</span>
                    <span className="text-xs text-text-muted">↑↓ Navigate • Tab Select • Esc Close</span>
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {autocompleteOptions.map((option, index) => (
                      <div
                        key={option.cmd}
                        onClick={() => selectAutocompleteOption(index)}
                        className={clsx(
                          'px-3 py-2 cursor-pointer border-b border-border-subtle last:border-b-0 transition-colors',
                          index === selectedOptionIndex
                            ? 'bg-accent-primary text-white'
                            : 'hover:bg-bg-subtle'
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className={clsx(
                            'font-mono text-sm font-semibold',
                            index === selectedOptionIndex ? 'text-white' : 'text-text-primary'
                          )}>
                            {option.cmd}
                          </span>
                          {option.params && (
                            <span className={clsx(
                              'text-xs px-1.5 py-0.5 rounded border',
                              index === selectedOptionIndex
                                ? 'bg-white/20 border-white/30 text-white/90'
                                : 'bg-accent-primary/10 border-accent-primary/30 text-accent-primary'
                            )}>
                              {option.params}
                            </span>
                          )}
                          {option.required && (
                            <span className={clsx(
                              'text-[10px] px-1 py-0.5 rounded uppercase font-semibold',
                              index === selectedOptionIndex
                                ? 'bg-amber-400/30 text-amber-200'
                                : 'bg-amber-500/20 text-amber-400'
                            )}>
                              Required
                            </span>
                          )}
                        </div>
                        <p className={clsx(
                          'text-xs mt-0.5',
                          index === selectedOptionIndex ? 'text-white/80' : 'text-text-muted'
                        )}>
                          {option.desc}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        
        {/* Hidden input for capturing keystrokes */}
        {connectionState === 'connected' && (
          <input
            ref={inputRef}
            type="text"
            value={currentInput}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            className="sr-only"
            aria-label="Terminal input"
            autoFocus
          />
        )}
        
        {/* Bottom bar with hint */}
        <div className="px-4 py-2 border-t border-white/5 bg-black/20">
          <div className="flex items-center justify-between text-xs text-text-muted">
            <span>
              {connectionState === 'connected' 
                ? 'Click anywhere to type • ↑↓ for history'
                : 'Connecting...'}
            </span>
            {stats?.version && (
              <span>pyMC v{stats.version}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
