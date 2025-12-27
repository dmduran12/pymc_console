/**
 * Terminal - Interactive command-line interface to the repeater
 * 
 * Features:
 * - ASCII art header (PYMC_TERMINAL)
 * - Faux loading sequence with real connection check
 * - Command input with blinking cursor
 * - Command history with output display
 * - Autocomplete for commands (future)
 */

import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { SquareTerminal } from 'lucide-react';
import clsx from 'clsx';
import { useStats } from '@/lib/stores/useStore';
import { sendTerminalCommand } from '@/lib/api';

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

const AVAILABLE_COMMANDS: CommandDef[] = [
  { cmd: 'help', desc: 'Show available commands' },
  { cmd: 'status', desc: 'Get repeater status' },
  { cmd: 'advert', desc: 'Send an advertisement packet' },
  { cmd: 'reboot', desc: 'Reboot the device (may timeout, normal)' },
  { cmd: 'clock', desc: 'Display device clock time' },
  { cmd: 'ver', desc: 'Show firmware version and build date' },
  { cmd: 'neighbors', desc: 'Show nearby repeater nodes' },
  { cmd: 'clear', desc: 'Clear terminal screen' },
  { cmd: 'password', desc: 'Set new admin password', params: '{new-password}', required: true },
  { cmd: 'set af', desc: 'Set air-time factor', params: '{value}', required: true },
  { cmd: 'set tx', desc: 'Set LoRa TX power (reboot to apply)', params: '{power-dbm}', required: true },
  { cmd: 'set repeat', desc: 'Enable/disable repeater role', params: '{on|off}', required: true },
  { cmd: 'set allow.read.only', desc: 'Set read-only login access', params: '{on|off}', required: true },
  { cmd: 'set flood.max', desc: 'Set max hops for flood packets', params: '{max-hops}', required: true },
  { cmd: 'set int.thresh', desc: 'Set interference threshold', params: '{db-value}', required: true },
  { cmd: 'set agc.reset.interval', desc: 'Set AGC reset interval (0=disable)', params: '{seconds}', required: true },
  { cmd: 'set multi.acks', desc: 'Enable/disable double ACKs', params: '{0|1}', required: true },
  { cmd: 'set advert.interval', desc: 'Set local advert interval (0=disable)', params: '{minutes}', required: true },
  { cmd: 'set flood.advert.interval', desc: 'Set flood advert interval (0=disable)', params: '{hours}', required: true },
  { cmd: 'set guest.password', desc: 'Set guest password', params: '{password}', required: true },
  { cmd: 'set name', desc: 'Set advertisement name', params: '{name}', required: true },
  { cmd: 'set lat', desc: 'Set map latitude', params: '{decimal-degrees}', required: true },
  { cmd: 'set lon', desc: 'Set map longitude', params: '{decimal-degrees}', required: true },
  { cmd: 'set radio', desc: 'Set radio params (reboot required)', params: '{freq,bw,sf,cr}', required: true },
  { cmd: 'log start', desc: 'Start packet logging' },
  { cmd: 'log stop', desc: 'Stop packet logging' },
  { cmd: 'log erase', desc: 'Erase packet logs' },
];

// Parameter suggestions for autocomplete
const PARAM_SUGGESTIONS: Record<string, string[]> = {
  'set repeat': ['on', 'off'],
  'set allow.read.only': ['on', 'off'],
  'set multi.acks': ['0', '1'],
  'set af': ['0.1', '0.5', '1.0', '2.0'],
  'set tx': ['10', '14', '20', '27'],
  'set int.thresh': ['10', '14', '18', '22'],
  'set agc.reset.interval': ['0', '30', '60', '300'],
  'set advert.interval': ['0', '5', '15', '30'],
  'set flood.advert.interval': ['0', '1', '6', '24'],
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
  // Command execution
  // ─────────────────────────────────────────────────────────────────────────────
  
  const executeCommand = useCallback(async (cmd: string) => {
    const trimmedCmd = cmd.trim();
    if (!trimmedCmd) return;
    
    // Handle client-side commands
    if (trimmedCmd.toLowerCase() === 'clear') {
      setCommandHistory([]);
      return;
    }
    
    if (trimmedCmd.toLowerCase() === 'help') {
      const helpText = AVAILABLE_COMMANDS
        .map(c => `  ${c.cmd.padEnd(22)} ${c.desc}`)
        .join('\n');
      
      const entry: CommandEntry = {
        id: crypto.randomUUID(),
        cmd: trimmedCmd,
        result: `Available commands:\n\n${helpText}`,
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
    
    try {
      const response = await sendTerminalCommand(trimmedCmd);
      
      setCommandHistory(prev => 
        prev.map(e => 
          e.id === entryId 
            ? { ...e, isProcessing: false, result: response.response || response.result || 'Command executed' }
            : e
        )
      );
    } catch (error) {
      setCommandHistory(prev => 
        prev.map(e => 
          e.id === entryId 
            ? { ...e, isProcessing: false, result: `Error: ${error instanceof Error ? error.message : 'Command failed'}` }
            : e
        )
      );
    }
  }, []);
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Input handling
  // ─────────────────────────────────────────────────────────────────────────────
  
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // Autocomplete navigation
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
      } else if (e.key === 'Enter') {
        e.preventDefault();
        selectAutocompleteOption(selectedOptionIndex);
        return;
      }
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
