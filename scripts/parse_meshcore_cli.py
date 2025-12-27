#!/usr/bin/env python3
"""
MeshCore CommonCLI Parser

Fetches CommonCLI.cpp from the MeshCore repository and extracts all CLI command
definitions into a structured JSON registry. This enables:

1. Terminal.tsx to implement 1:1 command parity with MeshCore
2. mesh_cli.py to stay in sync with upstream MeshCore changes
3. Documentation generation for available commands

Usage:
    python parse_meshcore_cli.py [--output meshcore-commands.json]
    
The script parses the C++ source looking for:
- memcmp(command, "xyz", N) patterns for command matching
- sprintf(reply, ...) patterns for response formats
- Parameter extraction patterns for command arguments

Output JSON format:
{
    "version": "git-sha or date",
    "source_url": "https://...",
    "commands": [
        {
            "name": "set af",
            "category": "set",
            "params": [{"name": "value", "type": "float"}],
            "response_format": "OK",
            "description": "Set airtime factor",
            "serial_only": false
        },
        ...
    ]
}
"""

import re
import json
import argparse
import urllib.request
from datetime import datetime
from typing import List, Dict, Any, Optional

COMMONCLI_URL = "https://raw.githubusercontent.com/meshcore-dev/MeshCore/main/src/helpers/CommonCLI.cpp"
COMMONCLI_HEADER_URL = "https://raw.githubusercontent.com/meshcore-dev/MeshCore/main/src/helpers/CommonCLI.h"


def fetch_source(url: str) -> str:
    """Fetch source file from GitHub."""
    print(f"Fetching {url}...")
    with urllib.request.urlopen(url) as response:
        return response.read().decode('utf-8')


def parse_commands(cpp_source: str) -> List[Dict[str, Any]]:
    """
    Parse CommonCLI.cpp to extract command definitions.
    
    We look for patterns like:
    - memcmp(command, "xyz", N) == 0
    - memcmp(config, "xyz", N) == 0  (for get/set subcommands)
    """
    commands = []
    
    # Track current context (are we inside get/set block?)
    lines = cpp_source.split('\n')
    
    # Pattern for command matching: memcmp(command, "xyz", N) == 0
    # or memcmp(config, "xyz", N) == 0 for get/set subcommands
    cmd_pattern = re.compile(
        r'memcmp\s*\(\s*(command|config)\s*,\s*"([^"]+)"\s*,\s*(\d+)\s*\)'
    )
    
    # Pattern for sprintf reply format
    reply_pattern = re.compile(r'sprintf\s*\(\s*reply\s*,\s*"([^"]*)"')
    strcpy_pattern = re.compile(r'strcpy\s*\(\s*reply\s*,\s*"([^"]*)"')
    
    # Pattern for serial-only check (sender_timestamp == 0)
    serial_only_pattern = re.compile(r'sender_timestamp\s*==\s*0')
    
    current_category = None
    in_get_block = False
    in_set_block = False
    serial_only_context = False
    
    i = 0
    while i < len(lines):
        line = lines[i]
        
        # Track if we're in a serial-only context
        if serial_only_pattern.search(line):
            serial_only_context = True
        
        # Detect get/set blocks
        if 'GET commands' in line or "memcmp(command, \"get \", 4)" in line:
            in_get_block = True
            in_set_block = False
            current_category = "get"
        elif 'SET commands' in line or "memcmp(command, \"set \", 4)" in line:
            in_set_block = True
            in_get_block = False
            current_category = "set"
        elif in_get_block and "} else if (memcmp(command" in line and "get " not in line:
            in_get_block = False
            current_category = None
        elif in_set_block and "} else if (memcmp(command" in line and "set " not in line:
            in_set_block = False
            current_category = None
        
        # Find command matches
        match = cmd_pattern.search(line)
        if match:
            var_name = match.group(1)  # 'command' or 'config'
            cmd_str = match.group(2)
            cmd_len = int(match.group(3))
            
            # Build full command name
            if var_name == 'config':
                if in_get_block:
                    full_cmd = f"get {cmd_str.strip()}"
                    category = "get"
                elif in_set_block:
                    full_cmd = f"set {cmd_str.strip()}"
                    category = "set"
                else:
                    full_cmd = cmd_str.strip()
                    category = "config"
            else:
                full_cmd = cmd_str.strip()
                category = classify_command(full_cmd)
            
            # Look ahead for response format and parameter info
            response_format = None
            params = []
            description = ""
            
            # Scan next few lines for context
            for j in range(i, min(i + 15, len(lines))):
                context_line = lines[j]
                
                # Check for reply format
                reply_match = reply_pattern.search(context_line)
                if reply_match and not response_format:
                    response_format = reply_match.group(1)
                
                strcpy_match = strcpy_pattern.search(context_line)
                if strcpy_match and not response_format:
                    response_format = strcpy_match.group(1)
                
                # Check for parameter extraction (atof, atoi, etc.)
                if 'atof(' in context_line:
                    params.append({"name": "value", "type": "float"})
                elif 'atoi(' in context_line or '_atoi(' in context_line:
                    params.append({"name": "value", "type": "int"})
                elif 'strncpy(' in context_line or 'StrHelper::strncpy(' in context_line:
                    params.append({"name": "value", "type": "string"})
            
            # Check if this is serial-only
            is_serial_only = serial_only_context or is_serial_only_command(full_cmd)
            
            # Don't add duplicates
            if not any(c['name'] == full_cmd for c in commands):
                commands.append({
                    "name": full_cmd,
                    "category": category,
                    "params": params,
                    "response_format": clean_response_format(response_format),
                    "description": generate_description(full_cmd),
                    "serial_only": is_serial_only,
                    "has_param": ' ' in cmd_str or len(params) > 0
                })
        
        # Reset serial-only context at block boundaries
        if line.strip().startswith('} else'):
            serial_only_context = False
        
        i += 1
    
    return commands


def classify_command(cmd: str) -> str:
    """Classify command into category."""
    if cmd.startswith('get '):
        return 'get'
    elif cmd.startswith('set '):
        return 'set'
    elif cmd.startswith('log'):
        return 'logging'
    elif cmd.startswith('gps'):
        return 'gps'
    elif cmd.startswith('sensor'):
        return 'sensor'
    elif cmd.startswith('bridge'):
        return 'bridge'
    elif cmd.startswith('stats'):
        return 'stats'
    elif cmd in ('neighbors', 'neighbor.remove'):
        return 'neighbor'
    elif cmd in ('reboot', 'advert', 'clock', 'clock sync', 'time', 'ver', 'board', 'erase', 'start ota', 'clear stats', 'password'):
        return 'system'
    elif cmd == 'tempradio':
        return 'radio'
    else:
        return 'other'


def is_serial_only_command(cmd: str) -> bool:
    """Check if command is serial-only (not exposed over mesh)."""
    serial_only = [
        'get prv.key', 'set prv.key', 'erase', 'log',
        'stats-packets', 'stats-radio', 'stats-core',
        'set freq'  # freq can only be set via serial
    ]
    return cmd in serial_only


def clean_response_format(fmt: Optional[str]) -> Optional[str]:
    """Clean up response format string."""
    if not fmt:
        return None
    # Replace format specifiers with placeholders
    fmt = re.sub(r'%0?2?d', '{int}', fmt)
    fmt = re.sub(r'%s', '{str}', fmt)
    fmt = re.sub(r'%u', '{uint}', fmt)
    fmt = re.sub(r'%.?\d*f', '{float}', fmt)
    return fmt


def generate_description(cmd: str) -> str:
    """Generate human-readable description for command."""
    descriptions = {
        # System
        'reboot': 'Reboot the device',
        'advert': 'Send self advertisement',
        'clock': 'Display current time',
        'clock sync': 'Sync clock from sender timestamp',
        'time': 'Set time to epoch seconds',
        'ver': 'Show firmware version and build date',
        'board': 'Show board/manufacturer name',
        'erase': 'Erase filesystem (serial only)',
        'start ota': 'Start OTA firmware update',
        'clear stats': 'Reset statistics counters',
        'password': 'Change admin password',
        
        # Get commands
        'get af': 'Get airtime factor',
        'get name': 'Get node name',
        'get repeat': 'Get repeat/forward status (on/off)',
        'get lat': 'Get latitude',
        'get lon': 'Get longitude',
        'get radio': 'Get radio params (freq,bw,sf,cr)',
        'get freq': 'Get frequency (MHz)',
        'get tx': 'Get TX power (dBm)',
        'get public.key': 'Get public key (hex)',
        'get prv.key': 'Get private key (serial only)',
        'get role': 'Get device role',
        'get rxdelay': 'Get RX delay base',
        'get txdelay': 'Get TX delay factor',
        'get direct.txdelay': 'Get direct TX delay factor',
        'get flood.max': 'Get max flood hops',
        'get guest.password': 'Get guest password',
        'get allow.read.only': 'Get read-only access setting',
        'get advert.interval': 'Get local advert interval (minutes)',
        'get flood.advert.interval': 'Get flood advert interval (hours)',
        'get int.thresh': 'Get interference threshold',
        'get agc.reset.interval': 'Get AGC reset interval (seconds)',
        'get multi.acks': 'Get multi-ack setting',
        'get adc.multiplier': 'Get ADC multiplier for battery',
        'get bridge.type': 'Get bridge type (rs232/espnow/none)',
        'get bridge.enabled': 'Get bridge enabled status',
        'get bridge.delay': 'Get bridge delay (ms)',
        'get bridge.source': 'Get bridge packet source',
        'get bridge.baud': 'Get bridge baud rate',
        'get bridge.channel': 'Get bridge channel (ESP-NOW)',
        'get bridge.secret': 'Get bridge encryption secret',
        
        # Set commands (same as get but with set prefix)
        'set af': 'Set airtime factor (0-9)',
        'set name': 'Set node name',
        'set repeat': 'Set repeat/forward (on/off)',
        'set lat': 'Set latitude',
        'set lon': 'Set longitude',
        'set radio': 'Set radio params (freq bw sf cr)',
        'set freq': 'Set frequency MHz (serial only, reboot required)',
        'set tx': 'Set TX power (dBm)',
        'set prv.key': 'Set private key (serial only)',
        'set rxdelay': 'Set RX delay base',
        'set txdelay': 'Set TX delay factor',
        'set direct.txdelay': 'Set direct TX delay factor',
        'set flood.max': 'Set max flood hops (0-64)',
        'set guest.password': 'Set guest password',
        'set allow.read.only': 'Set read-only access (on/off)',
        'set advert.interval': 'Set local advert interval (60-240 min, 0=off)',
        'set flood.advert.interval': 'Set flood advert interval (3-48 hours, 0=off)',
        'set int.thresh': 'Set interference threshold',
        'set agc.reset.interval': 'Set AGC reset interval (seconds, rounded to 4)',
        'set multi.acks': 'Set multi-ack (0/1)',
        'set adc.multiplier': 'Set ADC multiplier',
        'set bridge.enabled': 'Enable/disable bridge',
        'set bridge.delay': 'Set bridge delay (0-10000 ms)',
        'set bridge.source': 'Set bridge source (rx/tx)',
        'set bridge.baud': 'Set bridge baud (9600-115200)',
        'set bridge.channel': 'Set bridge channel (1-14)',
        'set bridge.secret': 'Set bridge encryption secret',
        
        # Neighbor
        'neighbors': 'List neighbors',
        'neighbor.remove': 'Remove neighbor by pubkey',
        
        # Radio
        'tempradio': 'Apply temporary radio params (freq bw sf cr timeout_mins)',
        
        # Logging
        'log': 'Dump log file (serial only)',
        'log start': 'Start packet logging',
        'log stop': 'Stop packet logging',
        'log erase': 'Erase log file',
        
        # Stats
        'stats-packets': 'Show packet statistics (serial only)',
        'stats-radio': 'Show radio statistics (serial only)',
        'stats-core': 'Show core statistics (serial only)',
        
        # Sensor
        'sensor get': 'Get sensor/custom variable value',
        'sensor set': 'Set sensor/custom variable value',
        'sensor list': 'List all sensor/custom variables',
        
        # GPS
        'gps': 'Show GPS status',
        'gps on': 'Enable GPS',
        'gps off': 'Disable GPS',
        'gps sync': 'Sync time from GPS',
        'gps setloc': 'Set node location from GPS',
        'gps advert': 'Get/set GPS advert location policy',
    }
    return descriptions.get(cmd, f"Execute {cmd} command")


def parse_prefs_struct(header_source: str) -> Dict[str, Dict[str, Any]]:
    """Parse NodePrefs struct from header to understand config fields."""
    prefs = {}
    
    # Find NodePrefs struct
    struct_match = re.search(r'struct NodePrefs\s*\{([^}]+)\}', header_source, re.DOTALL)
    if struct_match:
        struct_body = struct_match.group(1)
        
        # Parse each field
        field_pattern = re.compile(r'(float|double|char|uint8_t|uint16_t|uint32_t|int)\s+(\w+)(?:\[(\d+)\])?')
        for match in field_pattern.finditer(struct_body):
            field_type = match.group(1)
            field_name = match.group(2)
            array_size = match.group(3)
            
            prefs[field_name] = {
                'type': field_type,
                'array_size': int(array_size) if array_size else None
            }
    
    return prefs


def generate_registry(commands: List[Dict[str, Any]], prefs: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """Generate the final command registry."""
    # Sort commands by category then name
    commands.sort(key=lambda c: (c['category'], c['name']))
    
    # Group by category for easier consumption
    by_category = {}
    for cmd in commands:
        cat = cmd['category']
        if cat not in by_category:
            by_category[cat] = []
        by_category[cat].append(cmd)
    
    return {
        'version': datetime.utcnow().strftime('%Y-%m-%d'),
        'source_url': COMMONCLI_URL,
        'generated_by': 'parse_meshcore_cli.py',
        'total_commands': len(commands),
        'categories': list(by_category.keys()),
        'commands': commands,
        'commands_by_category': by_category,
        'node_prefs': prefs
    }


def main():
    parser = argparse.ArgumentParser(description='Parse MeshCore CommonCLI.cpp')
    parser.add_argument('--output', '-o', default='meshcore-commands.json',
                        help='Output JSON file path')
    parser.add_argument('--typescript', '-t', action='store_true',
                        help='Also generate TypeScript definitions')
    args = parser.parse_args()
    
    # Fetch sources
    cpp_source = fetch_source(COMMONCLI_URL)
    header_source = fetch_source(COMMONCLI_HEADER_URL)
    
    # Parse
    print("Parsing CommonCLI.cpp...")
    commands = parse_commands(cpp_source)
    print(f"Found {len(commands)} commands")
    
    print("Parsing NodePrefs struct...")
    prefs = parse_prefs_struct(header_source)
    print(f"Found {len(prefs)} preference fields")
    
    # Generate registry
    registry = generate_registry(commands, prefs)
    
    # Write JSON
    with open(args.output, 'w') as f:
        json.dump(registry, f, indent=2)
    print(f"Wrote {args.output}")
    
    # Optionally generate TypeScript
    if args.typescript:
        ts_output = args.output.replace('.json', '.ts')
        generate_typescript(registry, ts_output)
        print(f"Wrote {ts_output}")
    
    # Print summary
    print("\nCommand Summary:")
    for cat, cmds in registry['commands_by_category'].items():
        print(f"  {cat}: {len(cmds)} commands")


def generate_typescript(registry: Dict[str, Any], output_path: str):
    """Generate TypeScript definitions for commands."""
    lines = [
        "// Auto-generated from MeshCore CommonCLI.cpp",
        f"// Generated: {registry['version']}",
        f"// Source: {registry['source_url']}",
        "",
        "export interface MeshCoreCommand {",
        "  name: string;",
        "  category: string;",
        "  params: { name: string; type: string }[];",
        "  description: string;",
        "  serialOnly: boolean;",
        "  hasParam: boolean;",
        "}",
        "",
        "export const MESHCORE_COMMANDS: MeshCoreCommand[] = ["
    ]
    
    for cmd in registry['commands']:
        params_str = json.dumps(cmd['params'])
        lines.append(f"  {{")
        lines.append(f"    name: {json.dumps(cmd['name'])},")
        lines.append(f"    category: {json.dumps(cmd['category'])},")
        lines.append(f"    params: {params_str},")
        lines.append(f"    description: {json.dumps(cmd['description'])},")
        lines.append(f"    serialOnly: {str(cmd['serial_only']).lower()},")
        lines.append(f"    hasParam: {str(cmd['has_param']).lower()},")
        lines.append(f"  }},")
    
    lines.append("];")
    lines.append("")
    lines.append("export const MESHCORE_CATEGORIES = " + json.dumps(registry['categories']) + ";")
    lines.append("")
    
    with open(output_path, 'w') as f:
        f.write('\n'.join(lines))


if __name__ == '__main__':
    main()
