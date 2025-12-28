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

// Polyfill for crypto.randomUUID (not available in non-HTTPS contexts)
const generateId = (): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for HTTP contexts
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const ASCII_HEADER = `██████  ██    ██ ███    ███  ██████         ████████ ███████ ██████  ███    ███ ██ ███    ██  █████  ██      
██   ██  ██  ██  ████  ████ ██                 ██    ██      ██   ██ ████  ████ ██ ████   ██ ██   ██ ██      
██████    ████   ██ ████ ██ ██                 ██    █████   ██████  ██ ████ ██ ██ ██ ██  ██ ███████ ██      
██         ██    ██  ██  ██ ██                 ██    ██      ██   ██ ██  ██  ██ ██ ██  ██ ██ ██   ██ ██      
██         ██    ██      ██  ██████ ███████    ██    ███████ ██   ██ ██      ██ ██ ██   ████ ██   ██ ███████`;

type ConnectionState = 'initializing' | 'checking' | 'connected' | 'error';

// Output types for semantic coloring
type OutputType = 'success' | 'error' | 'warning' | 'info' | 'value' | 'default';

interface CommandEntry {
  id: string;
  cmd: string;
  result: string | null;
  outputType: OutputType;
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

/** Get color class for output type */
function getOutputColor(type: OutputType): string {
  switch (type) {
    case 'success': return 'text-accent-success';      // Green
    case 'error': return 'text-accent-danger';         // Red
    case 'warning': return 'text-amber-400';           // Amber
    case 'info': return 'text-accent-tertiary';        // Cyan
    case 'value': return 'text-accent-primary';        // Purple (values)
    default: return 'text-text-secondary';             // Default gray
  }
}

/** Colorize a line based on content patterns */
function colorizeLine(line: string, baseType: OutputType): { text: string; color: string }[] {
  // Help header
  if (line.startsWith('HELP_HEADER:::')) {
    return [{ text: line.slice(14), color: 'text-text-primary font-bold' }];
  }
  
  // Help note (footer)
  if (line.startsWith('HELP_NOTE:::')) {
    return [{ text: line.slice(12), color: 'text-text-muted italic' }];
  }
  
  // Help command line: cmd:::description
  const helpMatch = line.match(/^([a-z][a-z0-9.]*(?:\s+[a-z][a-z0-9.]*)?):::(.+)$/);
  if (helpMatch) {
    const [, cmd, desc] = helpMatch;
    const parts = cmd.split(' ');
    const segments: { text: string; color: string }[] = [];
    
    // First word (get/set/command) - green for get, amber for set, cyan for others
    const firstWord = parts[0];
    let cmdColor = 'text-accent-tertiary';  // cyan default
    if (firstWord === 'get') cmdColor = 'text-accent-success';  // green
    else if (firstWord === 'set') cmdColor = 'text-amber-400';  // amber
    
    segments.push({ text: `  ${firstWord}`, color: `${cmdColor} font-semibold` });
    
    // Remaining parts (qualifiers like txdelay, name, etc) - purple
    if (parts.length > 1) {
      segments.push({ text: ` ${parts.slice(1).join(' ')}`, color: 'text-accent-primary' });
    }
    
    // Pad and add description - muted
    const padding = ' '.repeat(Math.max(1, 20 - cmd.length));
    segments.push({ text: `${padding}${desc}`, color: 'text-text-muted' });
    
    return segments;
  }
  
  // If it's an error/warning type, color the whole line
  if (baseType === 'error' || baseType === 'warning') {
    return [{ text: line, color: getOutputColor(baseType) }];
  }
  
  // For value responses (single values like "TRHS-pi" or "1.2")
  if (baseType === 'value') {
    return [{ text: line, color: getOutputColor('value') }];
  }
  
  // Check for key: value patterns
  const kvMatch = line.match(/^([\w\s.]+):\s*(.+)$/);
  if (kvMatch) {
    const [, key, value] = kvMatch;
    return [
      { text: `${key}: `, color: 'text-text-muted' },
      { text: value, color: 'text-accent-primary font-semibold' },
    ];
  }
  
  // Check for "OK" success indicators
  if (line.startsWith('OK')) {
    return [{ text: line, color: getOutputColor('success') }];
  }
  
  // Default
  return [{ text: line, color: getOutputColor(baseType) }];
}

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
    <div className="py-2 border-b border-white/5 last:border-b-0">
      {/* Command line */}
      <div className="flex items-center gap-2">
        <span className="text-text-muted font-medium select-none">$</span>
        <span className="text-text-primary font-semibold">{entry.cmd}</span>
      </div>
      
      {/* Output */}
      {entry.isProcessing ? (
        <div className="mt-1 ml-4 text-text-muted italic">
          processing...
        </div>
      ) : statusItems ? (
        <StatusTable items={statusItems} nodeName={nodeName} />
      ) : entry.result ? (
        <div className="mt-1 ml-4 font-mono text-[13px]">
          {entry.result.split('\n').map((line, i) => {
            const segments = colorizeLine(line, entry.outputType);
            return (
              <div key={i} className="leading-relaxed">
                {segments.map((seg, j) => (
                  <span key={j} className={seg.color}>{seg.text}</span>
                ))}
              </div>
            );
          })}
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
  const nodeName = stats?.config?.node_name || stats?.node_name || 'pymc';
  
  // Connection state
  const [connectionState, setConnectionState] = useState<ConnectionState>('initializing');
  const [loadingStep, setLoadingStep] = useState(0);
  
  // Terminal state
  const [commandHistory, setCommandHistory] = useState<CommandEntry[]>([]);
  const [currentInput, setCurrentInput] = useState('');
  const [historyIndex, setHistoryIndex] = useState(-1);
  
  // Autocomplete state
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteOptions, setAutocompleteOptions] = useState<CommandDef[]>([]);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState(0);
  
  // Refs
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const autocompleteRef = useRef<HTMLDivElement>(null);
  
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
    
    let matches: CommandDef[] = [];
    
    // First, always check for commands that START with the input
    // This handles multi-word commands like "set bw", "set bridge.channel"
    const commandMatches = AVAILABLE_COMMANDS.filter(
      c => c.cmd.toLowerCase().startsWith(trimmed)
    );
    
    // If we have command matches, use those
    if (commandMatches.length > 0) {
      matches = commandMatches;
    } else if (trimmed.includes(' ')) {
      // No command matches - check for parameter suggestions
      // Find the longest matching command prefix
      const words = trimmed.split(' ');
      
      // Try progressively shorter prefixes to find a command match
      for (let i = words.length - 1; i >= 1; i--) {
        const baseCommand = words.slice(0, i).join(' ');
        const paramValue = words.slice(i).join(' ');
        
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
          break;
        }
      }
    }
    
    if (matches.length > 0) {
      setAutocompleteOptions(matches);
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
      // Format help with markers for coloring: CMD:::description
      const helpText = AVAILABLE_COMMANDS
        .map(c => `${c.cmd}:::${c.desc}`)
        .join('\n');
      
      const entry: CommandEntry = {
        id: generateId(),
        cmd: trimmedCmd,
        result: `HELP_HEADER:::Available commands\n${helpText}\nHELP_NOTE:::Commands use existing API endpoints. Some MeshCore CLI commands are not available via HTTP.`,
        outputType: 'default',  // Use default so colorizeLine handles it
        isProcessing: false,
        timestamp: Date.now(),
      };
      setCommandHistory(prev => [...prev, entry]);
      return;
    }
    
    // Create entry with processing state
    const entryId = generateId();
    let outputType: OutputType = 'default';
    const entry: CommandEntry = {
      id: entryId,
      cmd: trimmedCmd,
      result: null,
      outputType: 'default',
      isProcessing: true,
      timestamp: Date.now(),
    };
    setCommandHistory(prev => [...prev, entry]);
    
    // Helper to update result with type
    const setResult = (result: string, type: OutputType = outputType) => {
      setCommandHistory(prev => 
        prev.map(e => e.id === entryId ? { ...e, isProcessing: false, result, outputType: type } : e)
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
          `Neighbors: ${neighbors} | Uptime: ${uptime}`,
          'info'
        );
        return;
      }
      
      if (lowerCmd === 'ver' || lowerCmd === 'version') {
        const ver = freshStats.version || 'unknown';
        const coreVer = freshStats.core_version || 'unknown';
        setResult(`pyMC Repeater v${ver}\npyMC Core v${coreVer}`, 'info');
        return;
      }
      
      if (lowerCmd === 'clock') {
        const now = new Date();
        setResult(now.toLocaleString(), 'value');
        return;
      }
      
      if (lowerCmd === 'uptime') {
        setResult(formatUptime(freshStats.uptime_seconds || 0), 'value');
        return;
      }
      
      if (lowerCmd === 'neighbors') {
        const neighbors = freshStats.neighbors || {};
        const entries = Object.entries(neighbors);
        if (entries.length === 0) {
          setResult('No neighbors discovered yet.', 'warning');
        } else {
          const lines = entries.map(([hash, info]) => {
            const name = info.name || info.node_name || 'Unknown';
            const rssi = info.rssi != null ? `${info.rssi}dBm` : '?';
            const snr = info.snr != null ? `${info.snr}dB` : '?';
            return `  ${hash.slice(0, 8)}  ${name.padEnd(16)} RSSI:${rssi.padStart(6)} SNR:${snr.padStart(5)}`;
          });
          setResult(`Neighbors (${entries.length}):\n${lines.join('\n')}`, 'info');
        }
        return;
      }
      
      if (lowerCmd === 'packets') {
        setResult(
          `rx: ${freshStats.rx_count ?? '?'}\ntx: ${freshStats.tx_count ?? '?'}\nfwd: ${freshStats.forwarded_count ?? '?'}\ndrop: ${freshStats.dropped_count ?? '?'}`,
          'info'
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
            setResult(freshStats.config?.node_name || 'Unknown', 'value');
            return;
          case 'public.key':
            setResult(freshStats.public_key || 'Not available', 'value');
            return;
          case 'role':
            setResult('repeater', 'value');
            return;
            
          // Radio params (MeshCore format: freq,bw,sf,cr)
          case 'radio': {
            if (!radio) { setResult('Radio config not available', 'warning'); return; }
            const freq = radio.frequency ? (radio.frequency / 1_000_000).toFixed(3) : '?';
            const bw = radio.bandwidth ? (radio.bandwidth / 1000) : '?';
            setResult(`${freq},${bw},${radio.spreading_factor || '?'},${radio.coding_rate || '?'}`, 'value');
            return;
          }
          case 'freq':
            setResult(radio?.frequency ? (radio.frequency / 1_000_000).toFixed(3) : '?', 'value');
            return;
          case 'tx':
            setResult(String(radio?.tx_power ?? '?'), 'value');
            return;
            
          // Timing
          case 'af':
            setResult(String(delays?.tx_delay_factor ?? '1.0'), 'value');
            return;
          case 'rxdelay':
            setResult('0', 'value');  // Not exposed in pyMC config
            return;
          case 'txdelay':
            setResult(String(delays?.tx_delay_factor ?? '1.0'), 'value');
            return;
          case 'direct.txdelay':
            setResult(String(delays?.direct_tx_delay_factor ?? '0.5'), 'value');
            return;
            
          // Repeater settings
          case 'repeat':
            setResult(repeater?.mode === 'forward' ? 'on' : 'off', 'value');
            return;
          case 'lat':
            setResult(String(repeater?.latitude ?? '0'), 'value');
            return;
          case 'lon':
            setResult(String(repeater?.longitude ?? '0'), 'value');
            return;
            
          // Intervals
          case 'advert.interval':
            setResult(String((repeater?.send_advert_interval_hours ?? 2) * 60), 'value');
            return;
          case 'flood.advert.interval':
            setResult(String(repeater?.send_advert_interval_hours ?? 24), 'value');
            return;
          case 'flood.max':
            setResult('3', 'value');  // Default, not exposed in config
            return;
          case 'agc.reset.interval':
            setResult('0', 'value');  // Not implemented in pyMC
            return;
            
          // Security
          case 'allow.read.only':
            setResult('off', 'value');  // Not exposed
            return;
          case 'guest.password':
            setResult('(not exposed via HTTP)', 'warning');
            return;
          case 'multi.acks':
            setResult('0', 'value');
            return;
          case 'int.thresh':
            setResult('0', 'value');
            return;
            
          // Mode (custom for pyMC)
          case 'mode':
            setResult(repeater?.mode || 'forward', 'value');
            return;
            
          default:
            setResult(`Unknown parameter: ${param}`, 'error');
            return;
        }
      }
      
      // board command (MeshCore parity)
      if (lowerCmd === 'board') {
        setResult('pyMC_Repeater (Linux/RPi)', 'value');
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
              `drop: ${freshStats.dropped_count ?? 0}`,
              'info'
            );
          } else {
            setResult(`rx: ${freshStats.rx_count ?? 0}, tx: ${freshStats.tx_count ?? 0}`, 'info');
          }
        } catch {
          setResult(`rx: ${freshStats.rx_count ?? 0}, tx: ${freshStats.tx_count ?? 0}`, 'info');
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
          `noise: ${freshStats.noise_floor_dbm ?? '?'} dBm`,
          'info'
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
          `airtime: ${freshStats.utilization_percent?.toFixed(1) ?? '?'}%`,
          'info'
        );
        return;
      }
      
      // clear stats
      if (lowerCmd === 'clear stats') {
        setResult('Error: Not implemented in pyMC_Repeater', 'error');
        return;
      }
      
      // tempradio <freq> <bw> <sf> <cr> - MeshCore format
      // Note: On pyMC_Repeater this persists to config.yaml (restart service to revert)
      if (lowerCmd.startsWith('tempradio ')) {
        const parts = lowerCmd.split(/\s+/);
        if (parts.length < 5) {
          setResult('Usage: tempradio <freq_mhz> <bw_khz> <sf> <cr>\nExample: tempradio 906.875 250 10 5', 'warning');
          return;
        }
        const freq = parseFloat(parts[1]);
        const bw = parseInt(parts[2]);
        const sf = parseInt(parts[3]);
        const cr = parseInt(parts[4]);
        
        if (isNaN(freq) || freq < 100 || freq > 1000) {
          setResult('Error: Frequency must be in MHz (e.g., 906.875)', 'error');
          return;
        }
        if (![125, 250, 500].includes(bw)) {
          setResult('Error: Bandwidth must be 125, 250, or 500 kHz', 'error');
          return;
        }
        if (isNaN(sf) || sf < 5 || sf > 12) {
          setResult('Error: Spreading factor must be 5-12', 'error');
          return;
        }
        if (isNaN(cr) || cr < 5 || cr > 8) {
          setResult('Error: Coding rate must be 5-8', 'error');
          return;
        }
        
        const response = await updateRadioConfig({
          frequency_mhz: freq,
          bandwidth_khz: bw,
          spreading_factor: sf,
          coding_rate: cr,
        });
        if (response.success) {
          setResult(`OK - Radio: ${freq}MHz, ${bw}kHz, SF${sf}, CR4/${cr}\nNote: Changes persist. Restart service to revert.`, 'success');
        } else {
          setResult(`Error: ${response.error || 'Failed to update radio config'}`, 'error');
        }
        return;
      }
      
      // neighbor.remove
      if (lowerCmd.startsWith('neighbor.remove ')) {
        setResult('Error: neighbor.remove not implemented via HTTP', 'error');
        return;
      }
      
      // password
      if (lowerCmd.startsWith('password ')) {
        setResult('Error: Use config.yaml to change password', 'error');
        return;
      }
      
      // log commands
      if (lowerCmd === 'log start' || lowerCmd === 'log stop' || lowerCmd === 'log erase') {
        setResult('Error: Log commands not implemented via HTTP', 'error');
        return;
      }
      
      // ═══════════════════════════════════════════════════════════════════════
      // ACTION COMMANDS - Use existing POST endpoints
      // ═══════════════════════════════════════════════════════════════════════
      
      if (lowerCmd === 'advert') {
        const response = await sendAdvert();
        setResult(response.success ? 'OK - Advert sent' : `Error: ${response.error || 'Failed'}`, response.success ? 'success' : 'error');
        return;
      }
      
      if (lowerCmd.startsWith('set mode ')) {
        const mode = lowerCmd.split(' ')[2];
        if (mode !== 'forward' && mode !== 'monitor') {
          setResult('Error: Mode must be "forward" or "monitor"', 'error');
          return;
        }
        const response = await setMode(mode as 'forward' | 'monitor');
        setResult(response.success ? `OK - Mode set to ${mode}` : 'Error: Failed to set mode', response.success ? 'success' : 'error');
        return;
      }
      
      if (lowerCmd.startsWith('set duty ')) {
        const val = lowerCmd.split(' ')[2];
        const enabled = val === 'on' || val === '1' || val === 'true';
        const response = await setDutyCycle(enabled);
        setResult(response.success ? `OK - Duty cycle ${enabled ? 'enabled' : 'disabled'}` : 'Error: Failed to set duty cycle', response.success ? 'success' : 'error');
        return;
      }
      
      if (lowerCmd.startsWith('set log ')) {
        const level = lowerCmd.split(' ')[2]?.toUpperCase();
        if (!['DEBUG', 'INFO', 'WARNING', 'ERROR'].includes(level)) {
          setResult('Error: Level must be debug, info, warning, or error', 'error');
          return;
        }
        const response = await setLogLevel(level as LogLevel);
        setResult(response.success ? `OK - Log level set to ${level}. Service restarting...` : `Error: ${response.error || 'Failed'}`, response.success ? 'success' : 'error');
        return;
      }
      
      if (lowerCmd.startsWith('set tx ')) {
        const power = parseInt(lowerCmd.split(' ')[2]);
        if (isNaN(power) || power < 2 || power > 22) {
          setResult('Error: TX power must be 2-22 dBm', 'error');
          return;
        }
        const response = await updateRadioConfig({ tx_power: power });
        setResult(response.success ? `OK - TX power set to ${power}dBm. Restart service to apply.` : `Error: ${response.error || 'Failed'}`, response.success ? 'success' : 'error');
        return;
      }
      
      if (lowerCmd.startsWith('set freq ')) {
        const freq = parseFloat(lowerCmd.split(' ')[2]);
        if (isNaN(freq) || freq < 100 || freq > 1000) {
          setResult('Error: Frequency must be in MHz (e.g., 906.875)', 'error');
          return;
        }
        const response = await updateRadioConfig({ frequency_mhz: freq });
        setResult(response.success ? `OK - Frequency set to ${freq}MHz. Restart service to apply.` : `Error: ${response.error || 'Failed'}`, response.success ? 'success' : 'error');
        return;
      }
      
      if (lowerCmd.startsWith('set sf ')) {
        const sf = parseInt(lowerCmd.split(' ')[2]);
        if (isNaN(sf) || sf < 5 || sf > 12) {
          setResult('Error: Spreading factor must be 5-12', 'error');
          return;
        }
        const response = await updateRadioConfig({ spreading_factor: sf });
        setResult(response.success ? `OK - SF set to ${sf}. Restart service to apply.` : `Error: ${response.error || 'Failed'}`, response.success ? 'success' : 'error');
        return;
      }
      
      if (lowerCmd.startsWith('set bw ')) {
        const bw = parseInt(lowerCmd.split(' ')[2]);
        if (![125, 250, 500].includes(bw)) {
          setResult('Error: Bandwidth must be 125, 250, or 500 kHz', 'error');
          return;
        }
        const response = await updateRadioConfig({ bandwidth_khz: bw });
        setResult(response.success ? `OK - Bandwidth set to ${bw}kHz. Restart service to apply.` : `Error: ${response.error || 'Failed'}`, response.success ? 'success' : 'error');
        return;
      }
      
      // set txdelay / set af (they're the same thing - tx_delay_factor)
      if (lowerCmd.startsWith('set txdelay ') || lowerCmd.startsWith('set af ')) {
        const val = parseFloat(lowerCmd.split(' ')[2]);
        if (isNaN(val) || val < 0 || val > 5) {
          setResult('Error: TX delay factor must be 0.0-5.0', 'error');
          return;
        }
        const response = await updateRadioConfig({ tx_delay_factor: val });
        setResult(response.success ? `OK - TX delay set to ${val}. Restart service to apply.` : `Error: ${response.error || 'Failed'}`, response.success ? 'success' : 'error');
        return;
      }
      
      // set direct.txdelay
      if (lowerCmd.startsWith('set direct.txdelay ')) {
        const val = parseFloat(lowerCmd.split(' ')[2]);
        if (isNaN(val) || val < 0 || val > 5) {
          setResult('Error: Direct TX delay factor must be 0.0-5.0', 'error');
          return;
        }
        const response = await updateRadioConfig({ direct_tx_delay_factor: val });
        setResult(response.success ? `OK - Direct TX delay set to ${val}. Restart service to apply.` : `Error: ${response.error || 'Failed'}`, response.success ? 'success' : 'error');
        return;
      }
      
      // ═══════════════════════════════════════════════════════════════════════
      // UNKNOWN COMMAND
      // ═══════════════════════════════════════════════════════════════════════
      
      setResult(`Unknown command: ${trimmedCmd}\nType 'help' for available commands.`, 'error');
      
    } catch (error) {
      setResult(`Error: ${error instanceof Error ? error.message : 'Command failed'}`, 'error');
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
        const newIndex = Math.min(selectedOptionIndex + 1, autocompleteOptions.length - 1);
        setSelectedOptionIndex(newIndex);
        // Scroll into view
        const container = autocompleteRef.current;
        const item = container?.children[0]?.children[newIndex] as HTMLElement | undefined;
        item?.scrollIntoView({ block: 'nearest' });
        return;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const newIndex = Math.max(selectedOptionIndex - 1, 0);
        setSelectedOptionIndex(newIndex);
        // Scroll into view
        const container = autocompleteRef.current;
        const item = container?.children[0]?.children[newIndex] as HTMLElement | undefined;
        item?.scrollIntoView({ block: 'nearest' });
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
      
      {/* Terminal Card - Full height with bottom input */}
      <div 
        className="glass-card overflow-hidden flex flex-col"
        style={{ height: 'calc(100vh - 180px)', minHeight: '400px' }}
        onClick={focusInput}
      >
        {/* Terminal History - flex-col-reverse keeps content bottom-aligned */}
        <div 
          ref={logRef}
          className="flex-1 flex flex-col-reverse overflow-y-auto font-mono text-sm bg-black/40"
        >
          {/* Scrollable content wrapper */}
          <div className="p-4 sm:p-5">
            {/* Command History */}
            {commandHistory.map(entry => (
              <CommandRow key={entry.id} entry={entry} nodeName={nodeName} />
            ))}
          </div>
        </div>
        
        {/* Bottom Input Bar - always visible */}
        <div className="relative border-t border-white/10 bg-black/50">
          {/* Loading state - shows above input during initialization */}
          {connectionState !== 'connected' && (
            <div className="px-4 pt-3 pb-2 border-b border-white/5">
              <div className="flex items-center gap-3 mb-2">
                <pre className="text-accent-primary/50 text-[0.35rem] sm:text-[0.4rem] leading-none overflow-hidden flex-shrink-0">
                  {ASCII_HEADER.split('\n')[0]}
                </pre>
              </div>
              <div className="space-y-1">
                <LoadingLine 
                  text="Initializing terminal..." 
                  status={loadingStep >= 1 ? (loadingStep === 1 ? 'active' : 'done') : 'pending'} 
                />
                <LoadingLine 
                  text="Checking repeater..." 
                  status={loadingStep >= 2 ? (loadingStep === 2 ? 'active' : 'done') : 'pending'} 
                />
                <LoadingLine 
                  text={connectionState === 'error' ? 'Connection failed' : 'Connected'} 
                  status={loadingStep >= 3 ? (connectionState === 'error' ? 'error' : 'done') : 'pending'} 
                />
              </div>
            </div>
          )}
          
          {/* Welcome hint when empty */}
          {connectionState === 'connected' && commandHistory.length === 0 && (
            <div className="px-4 py-2 border-b border-white/5 text-center">
              <span className="text-text-muted text-xs">Type a command or 'help' to get started</span>
            </div>
          )}
            {/* Autocomplete Shelf - pops UP from input */}
            {showAutocomplete && autocompleteOptions.length > 0 && (
              <div ref={autocompleteRef} className="absolute left-0 right-0 bottom-full bg-bg-elevated border-t border-x border-border-subtle rounded-t-lg shadow-2xl overflow-hidden z-10 mx-2 mb-0">
                <div className="max-h-64 overflow-y-auto">
                  {autocompleteOptions.map((option, index) => (
                    <div
                      key={option.cmd}
                      onClick={() => selectAutocompleteOption(index)}
                      className={clsx(
                        'px-4 py-2.5 cursor-pointer border-b border-border-subtle/50 last:border-b-0 transition-colors',
                        index === selectedOptionIndex
                          ? 'bg-accent-primary/20'
                          : 'hover:bg-white/5'
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <span className={clsx(
                          'font-mono text-sm font-semibold',
                          index === selectedOptionIndex ? 'text-accent-primary' : 'text-text-primary'
                        )}>
                          {option.cmd}
                        </span>
                        {option.params && (
                          <span className="text-xs text-text-muted font-mono">
                            {option.params}
                          </span>
                        )}
                        <span className="flex-1" />
                        <span className="text-xs text-text-muted truncate max-w-[200px]">
                          {option.desc}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="px-3 py-1.5 bg-bg-subtle border-t border-border-subtle flex justify-end">
                  <span className="text-[10px] text-text-muted">↑↓ Navigate • Tab Select • Enter Run</span>
                </div>
              </div>
            )}
            
          {/* Input Field - uses overlay technique for block cursor */}
          <div className="flex items-center gap-3 px-4 py-3">
            <span className="text-text-muted font-mono font-bold select-none">$</span>
            <div className="flex-1 relative">
              {/* Hidden input for actual typing */}
              <input
                ref={inputRef}
                type="text"
                value={currentInput}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder={connectionState === 'connected' ? 'Enter command...' : 'Connecting...'}
                disabled={connectionState !== 'connected'}
                className="w-full bg-transparent text-transparent font-mono text-sm outline-none disabled:opacity-50 absolute inset-0"
                style={{ caretColor: 'transparent' }}
                aria-label="Terminal input"
                autoFocus
              />
              {/* Visible text + block cursor */}
              <div className="font-mono text-sm pointer-events-none flex items-center">
                {currentInput ? (
                  <span className="text-text-primary">{currentInput}</span>
                ) : (
                  <span className="text-text-muted/50">
                    {connectionState === 'connected' ? 'Enter command...' : 'Connecting...'}
                  </span>
                )}
                <span 
                  className="inline-block w-2 h-[1.1em] bg-accent-primary/90 ml-px"
                  aria-hidden="true"
                />
              </div>
            </div>
          </div>
          
          {/* Hints bar */}
          <div className="px-4 py-1.5 border-t border-white/5 bg-black/30">
            <div className="flex items-center justify-between text-[10px] text-text-muted">
              <span>↑↓ History</span>
              {stats?.version && (
                <span className="text-text-muted/60">pyMC v{stats.version}</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
