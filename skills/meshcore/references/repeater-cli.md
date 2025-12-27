# Repeater & Room Server CLI Reference

CLI commands for **MeshCore firmware** devices (Heltec, RAK, etc.) via USB serial or remote CLI.

**Note**: pyMC_Repeater uses `config.yaml` and the web API instead of these CLI commands. This reference is useful for understanding MeshCore protocol behavior and for interacting with firmware-based repeaters in your mesh.

## Connection Methods

1. **USB Serial**: Connect device, use https://config.meshcore.dev or flasher console
2. **Remote CLI**: Via smartphone app or T-Deck (requires admin login)

## Configuration Commands

### Identity & Location
```
set name {name}           # Set node name (shown in adverts)
set lat {latitude}        # Set GPS latitude (decimal, e.g., 37.7749)
set long {longitude}      # Set GPS longitude (decimal, e.g., -122.4194)
```

### Radio Configuration
```
set freq {frequency}      # Set frequency in MHz (e.g., 910.525)
set bw {bandwidth}        # Set bandwidth (62.5, 125, 250, 500)
set sf {spreading_factor} # Set spreading factor (7-12)
set cr {coding_rate}      # Set coding rate (5-8)
set tx_power {dbm}        # Set TX power in dBm
```

### Repeater Behavior
```
set advert.interval {min} # Flood advert interval in minutes (default: 180)
set flood.max {hops}      # Max flood hops to allow (0 = deny all flood)
set repeat {on|off}       # Enable/disable packet forwarding (room server only)
```

### Timing & Delays
```
set tx_delay {factor}     # TX delay factor for flood routing
set direct_tx_delay {factor} # TX delay factor for direct routing
```

### Passwords
```
password {new-password}   # Set admin password (default: "password")
set guest.password {pw}   # Set guest password for room server (default: "hello")
```

### Keys
```
get prv.key               # Print private key (hex)
set prv.key {hex}         # Set private key (reboot after)
```

## Query Commands

```
get stats                 # Show node statistics
get config                # Show current configuration
get neighbors             # List known neighbors
time                      # Show/set system time
```

## Maintenance Commands

```
reboot                    # Restart the device
start ota                 # Enter OTA (over-the-air) update mode
factory_reset             # Reset to factory defaults
```

## Advanced Configuration

### AGC Reset (for interference issues)
```
set agc.reset.interval {seconds}  # Periodically reset radio AGC (try 4)
```
Helps if repeater suffers from "deafness" due to nearby high-power interference.

### Duty Cycle
```
set duty_cycle.enabled {true|false}
set duty_cycle.max_percent {percent}
```

## Default Values

| Setting | Default | Notes |
|---------|---------|-------|
| Admin password | `password` | Change immediately |
| Guest password | `hello` | Room server only |
| Advert interval | 180 min | May change to 720 (12h) |
| Flood max | Unlimited | Set to limit flood range |
| TX delay factor | 0.7 | MeshCore default |

## Key Generation

If node hash collides with existing node, generate new key with specific first byte:
https://gessaman.com/mc-keygen/
