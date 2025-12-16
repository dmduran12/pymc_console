# pyMC Console

A modern dashboard for monitoring and managing your [MeshCore](https://meshcore.co.uk/) LoRa mesh network repeater.

## Features

- **Real-time Monitoring** — Live packet counts, forwarding stats, and network activity
- **Traffic Analysis** — Time-bucketed charts showing received, forwarded, and dropped packets  
- **Neighbor Map** — Geographic visualization of mesh network neighbors
- **Radio Configuration** — Adjust frequency, spreading factor, bandwidth, and TX power
- **TX Delay Calculator** — Smart recommendations for optimal tx_delay settings
- **System Stats** — CPU, memory, disk, and temperature monitoring

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

## Credits

- [pyMC_Repeater](https://github.com/rightup/pyMC_Repeater) — Mesh repeater daemon
- [pymc_core](https://github.com/rightup/pyMC_core) — LoRa mesh protocol library
- [MeshCore](https://meshcore.co.uk/) — The MeshCore project
