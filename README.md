# pymc_console

A modern Next.js dashboard and monitoring stack for [pyMC_Repeater](https://github.com/rightup/pyMC_Repeater).

This project provides:
- **Next.js Frontend** - Modern React dashboard for monitoring your mesh repeater
- **Grafana + Prometheus** - Time-series metrics and visualization

## Architecture

```
pymc_console/
├── frontend/           # Next.js dashboard (React 19, Tailwind CSS)
├── monitoring/         # Grafana dashboards and Prometheus config
├── docker-compose.yml  # Container orchestration for full stack
├── install.sh          # Automated installer
└── README.md
```

The installer pulls upstream `pyMC_Repeater` (which includes `pymc_core`) and sets up the frontend alongside it.

## Prerequisites

- Python 3.10+
- Node.js 18+
- Git
- Docker & Docker Compose (optional, for monitoring stack)

## Quick Start

### Install with default branch (dev)

```bash
git clone https://github.com/dmduran12/pymc_console.git
cd pymc_console
./install.sh
```

### Install with specific branch

```bash
./install.sh dev          # development branch (default)
./install.sh main         # stable release branch
```

### Custom install location

```bash
INSTALL_DIR=/home/user/pymc ./install.sh
```

## What Gets Installed

| Component | Location | Description |
|-----------|----------|-------------|
| pymc_core | venv | LoRa radio + protocol library |
| pyMC_Repeater | /opt/pymc_console/pymc_repeater | Repeater daemon + Vue.js frontend |
| Next.js Frontend | /opt/pymc_console/frontend | Modern dashboard |
| Monitoring | /opt/pymc_console/monitoring | Grafana + Prometheus configs |

## Running the Stack

### 1. Start the Repeater

```bash
source /opt/pymc_console/venv/bin/activate
cd /opt/pymc_console/pymc_repeater
python -m repeater.main
```

Or use the systemd service:
```bash
sudo /opt/pymc_console/pymc_repeater/manage.sh
sudo systemctl start pymc-repeater
```

### 2. Start the Frontend

```bash
cd /opt/pymc_console/frontend
npm run start
# Dashboard at http://localhost:3000
```

### 3. Start Monitoring (Optional)

```bash
cd /opt/pymc_console
docker-compose up -d

# Grafana: http://localhost:3002 (admin/admin)
# Prometheus: http://localhost:9090
```

## Configuration

### Frontend API URL

Edit `/opt/pymc_console/frontend/.env.local`:

```env
# Local repeater
NEXT_PUBLIC_API_URL=http://localhost:8000

# Remote repeater
NEXT_PUBLIC_API_URL=http://192.168.1.100:8000
```

### Repeater Configuration

Copy and edit the config template:

```bash
sudo mkdir -p /etc/pymc_repeater
sudo cp /opt/pymc_console/pymc_repeater/config.yaml.example /etc/pymc_repeater/config.yaml
sudo nano /etc/pymc_repeater/config.yaml
```

## Branch Synchronization

This installer ensures `pymc_core` and `pyMC_Repeater` use matching branches:

```bash
# Both will use 'dev' branch (default)
./install.sh dev

# Both will use 'main' branch
./install.sh main
```

The installer pre-installs `pymc_core` at the specified branch before installing `pyMC_Repeater`, ensuring pip respects the already-installed version.

## Updating

Re-run the installer to update to latest:

```bash
cd /path/to/pymc_console
git pull
./install.sh dev  # or your preferred branch
```

## Development

### Frontend Development

```bash
cd frontend
npm install
npm run dev  # Hot-reload at http://localhost:3000
```

### Building for Production

```bash
cd frontend
npm run build
npm run start
```

## API Endpoints

The Next.js frontend connects to the pyMC_Repeater API:

| Endpoint | Description |
|----------|-------------|
| `/api/stats` | System statistics |
| `/api/recent_packets` | Recent packet history |
| `/api/packet_stats` | Packet statistics over time |
| `/api/rrd_data` | Time-series metrics |
| `/api/logs` | Recent log entries |

## License

MIT - See LICENSE file

## Credits

- [pymc_core](https://github.com/rightup/pyMC_core) - LoRa mesh protocol library
- [pyMC_Repeater](https://github.com/rightup/pyMC_Repeater) - Mesh repeater daemon
