# pyMC Console

A modern dashboard for monitoring and managing your [MeshCore](https://meshcore.co.uk/) LoRa mesh network repeater.

Built on top of [pyMC_Repeater](https://github.com/rightup/pyMC_Repeater) by [RightUp](https://github.com/rightup), pyMC Console adds a Next.js dashboard that makes it easy to monitor your mesh network from any browser.

## Features

### Dashboard Home
The main dashboard provides an at-a-glance view of your repeater's activity:

- **Received Packets** — Hero chart showing packets received over your selected time window (20m to 7d). The large number shows total packets in the period, with an hourly rate below.
- **Forwarded** — Packets your repeater has retransmitted to extend network coverage. A healthy repeater forwards most of what it receives.
- **Dropped** — Packets that were filtered (duplicates, out-of-range, etc.). Some drops are normal—duplicates mean the mesh is working.
- **TX Delay Calculator** — Analyzes your duplicate rate and TX utilization to recommend optimal `tx_delay_factor` and `direct_tx_delay_factor` settings. If the "Adjust" badge appears, consider updating your config.
- **Uptime** — Time since last service restart.

Use the time range selector (20m, 1h, 3h, 12h, 24h, 3d, 7d) to adjust all dashboard stats and charts to your desired window.

### Statistics Page
Deeper analytics for network performance:

- **Traffic Flow Chart** — Stacked area chart showing received/forwarded/dropped packets over time. The right Y-axis shows estimated RX airtime utilization percentage. Max and Mean RX Util are displayed in the header.
- **Link Quality Polar Chart** — Visualizes neighbor signal quality by direction. Neighbors are plotted by their bearing from your location, with bar length indicating SNR quality.
- **Packet Types Treemap** — Distribution of packet types (ADVERT, TXT_MSG, ACK, REQ, etc.) as a proportional treemap.
- **Noise Floor Heatmap** — Historical noise floor readings to identify RF interference patterns.

### Neighbors Page
- **Interactive Map** — OpenStreetMap view showing your repeater and all known neighbors with coordinates. Click markers for details.
- **Neighbor List** — Sortable table with name, last seen time, RSSI, SNR, and whether they're zero-hop (direct) or relayed.

### Packets Page
- **Packet History** — Searchable, filterable list of all packets. Filter by type, route, or time range.
- **Packet Details** — Click any packet to see full details: hash, source/destination, path, payload, signal info, and duplicate history.

### Settings Page
- **Operating Mode** — Toggle between Forward (active repeating) and Monitor (receive-only) modes.
- **Duty Cycle** — Enable/disable duty cycle enforcement for regulatory compliance.
- **Radio Configuration** — Live-edit frequency, TX power, spreading factor, bandwidth, and coding rate. Changes can be applied without restart.

### System Page
- **Hardware Stats** — Real-time CPU usage, memory, disk space, and temperature (on supported hardware).
- **Load Averages** — 1/5/15 minute load averages.

### Logs Page
- **Live Logs** — Stream of recent log entries from the repeater daemon. Useful for debugging RX/TX issues.

## Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/dmduran12/pymc_console.git
cd pymc_console
```

### 2. Run the Installer

```bash
sudo bash manage.sh install
```

That's it! The installer will guide you through the setup process.

## What Gets Installed

The installer automatically:
- Installs all required system dependencies (git, curl, whiptail, Python packages)
- Clones and configures [pyMC_Repeater](https://github.com/rightup/pyMC_Repeater)
- Sets up the systemd service for automatic startup
- Deploys the Next.js dashboard
- Creates the configuration file at `/etc/pymc_repeater/config.yaml`

## Using the Installer Menu

After installation, run `sudo bash manage.sh` to access the management menu:

```
┌─────────────────────────────────────┐
│     pyMC Console Management         │
├─────────────────────────────────────┤
│  1. Start Service                   │
│  2. Stop Service                    │
│  3. Restart Service                 │
│  4. View Logs                       │
│  5. Configure Radio                 │
│  6. Configure GPIO                  │
│  7. Upgrade                         │
│  8. Uninstall                       │
│  9. Exit                            │
└─────────────────────────────────────┘
```

### Menu Options

| Option | Description |
|--------|-------------|
| **Start/Stop/Restart** | Control the repeater service |
| **View Logs** | Live log output from the repeater |
| **Configure Radio** | Set frequency, power, bandwidth, SF via preset selection |
| **Configure GPIO** | Set up SPI bus and GPIO pins for your LoRa module |
| **Upgrade** | Pull latest updates and reinstall |
| **Uninstall** | Remove the installation completely |

## Accessing the Dashboard

Once installed and running, access your dashboard at:

```
http://<your-pi-ip>:8000/
```

The dashboard is served directly by the repeater backend — no separate web server needed.

## Upgrading

To update to the latest version:

```bash
cd pymc_console
git pull
sudo bash manage.sh
```

Then select **Upgrade** from the menu.

## Configuration

### Radio Settings

Use the **Configure Radio** menu option, or edit directly:

```bash
sudo nano /etc/pymc_repeater/config.yaml
```

Key settings:
```yaml
radio:
  frequency: 906000000      # Frequency in Hz
  spreading_factor: 7       # SF7-SF12
  bandwidth: 62500          # Bandwidth in Hz  
  tx_power: 22              # TX power in dBm
  coding_rate: 5            # 4/5, 4/6, 4/7, or 4/8
```

### Service Management

```bash
# Check status
sudo systemctl status pymc-repeater

# Start/stop/restart
sudo systemctl start pymc-repeater
sudo systemctl stop pymc-repeater
sudo systemctl restart pymc-repeater

# View live logs
sudo journalctl -u pymc-repeater -f
```

## Hardware Requirements

- **Raspberry Pi** (3, 4, 5, or Zero 2 W recommended)
- **LoRa Module** — SX1262 or SX1276 based (e.g., Waveshare SX1262, LILYGO T3S3)
- **SPI Connection** — Module connected via SPI with GPIO for reset/busy/DIO1

### Tested Modules

- Waveshare SX1262 HAT
- LILYGO T3S3 (via USB serial)
- Ebyte E22 modules
- Heltec LoRa 32

## Troubleshooting

### Service won't start

```bash
# Check for errors
sudo journalctl -u pymc-repeater -n 50

# Verify config syntax
cat /etc/pymc_repeater/config.yaml
```

### No packets being received

1. Verify SPI is enabled: `ls /dev/spidev*`
2. Check GPIO configuration in manage.sh → Configure GPIO
3. Confirm frequency matches your network

### Dashboard not loading

1. Verify service is running: `sudo systemctl status pymc-repeater`
2. Check if port 8000 is accessible: `curl http://localhost:8000/api/stats`

## Uninstalling

```bash
cd pymc_console
sudo bash manage.sh
```

Select **Uninstall** from the menu. This removes:
- `/opt/pymc_repeater` (installation)
- `/etc/pymc_repeater` (configuration)  
- `/var/log/pymc_repeater` (logs)
- The systemd service

## Development

See [WARP.md](WARP.md) for development setup and architecture details.

### Local Frontend Development

```bash
cd frontend
npm install
npm run dev  # http://localhost:3000
```

Set `NEXT_PUBLIC_API_URL` in `frontend/.env.local` to point to your Pi:
```
NEXT_PUBLIC_API_URL=http://192.168.1.100:8000
```

## License

MIT — See [LICENSE](LICENSE)

## Credits & Acknowledgments

This project wouldn't exist without the work of [RightUp](https://github.com/rightup):

- **[pyMC_Repeater](https://github.com/rightup/pyMC_Repeater)** — The core mesh repeater daemon that handles all LoRa communication, packet routing, and mesh protocol logic. pyMC Console is essentially a dashboard layer on top of this excellent project.
- **[pymc_core](https://github.com/rightup/pyMC_core)** — The underlying LoRa mesh protocol library.

Also thanks to:
- **[MeshCore](https://meshcore.co.uk/)** — The MeshCore project and community.
