#!/bin/bash
#
# pymc_console installer
#
# Installs pyMC_Repeater (which pulls pymc_core) and sets up the Next.js frontend.
#
# Usage:
#   ./install.sh              # Uses 'dev' branch (default)
#   ./install.sh dev          # Uses 'dev' branch explicitly
#   ./install.sh main         # Uses 'main' branch
#

set -e

BRANCH="${1:-dev}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/pymc_console}"
REPEATER_DIR="${INSTALL_DIR}/pymc_repeater"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_banner() {
    echo ""
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║              pymc_console Installer                       ║"
    echo "║                                                           ║"
    echo "║  Next.js Dashboard + Monitoring for pyMC_Repeater         ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo ""
    echo "Branch: ${BRANCH}"
    echo "Install directory: ${INSTALL_DIR}"
    echo ""
}

check_dependencies() {
    log_info "Checking dependencies..."
    
    local missing=()
    
    # Check for Python 3.10+
    if command -v python3 &> /dev/null; then
        PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
        if [[ $(echo "${PYTHON_VERSION} >= 3.10" | bc -l) -eq 0 ]]; then
            missing+=("python3 >= 3.10 (found ${PYTHON_VERSION})")
        fi
    else
        missing+=("python3")
    fi
    
    # Check for pip
    if ! command -v pip3 &> /dev/null; then
        missing+=("pip3")
    fi
    
    # Check for Node.js
    if command -v node &> /dev/null; then
        NODE_VERSION=$(node -v | sed 's/v//')
        NODE_MAJOR=$(echo "${NODE_VERSION}" | cut -d. -f1)
        if [[ ${NODE_MAJOR} -lt 18 ]]; then
            missing+=("node >= 18 (found ${NODE_VERSION})")
        fi
    else
        missing+=("node (>= 18)")
    fi
    
    # Check for npm
    if ! command -v npm &> /dev/null; then
        missing+=("npm")
    fi
    
    # Check for git
    if ! command -v git &> /dev/null; then
        missing+=("git")
    fi
    
    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing dependencies:"
        for dep in "${missing[@]}"; do
            echo "  - ${dep}"
        done
        exit 1
    fi
    
    log_success "All dependencies satisfied"
}

create_virtualenv() {
    log_info "Creating Python virtual environment..."
    
    if [[ -d "${INSTALL_DIR}/venv" ]]; then
        log_warn "Virtual environment already exists, removing..."
        rm -rf "${INSTALL_DIR}/venv"
    fi
    
    python3 -m venv "${INSTALL_DIR}/venv"
    source "${INSTALL_DIR}/venv/bin/activate"
    pip install --upgrade pip wheel setuptools
    
    log_success "Virtual environment created"
}

install_pymc_core() {
    log_info "Installing pymc_core@${BRANCH}..."
    
    # Install pymc_core first at specific branch so pip won't re-fetch
    pip install "pymc_core[hardware] @ git+https://github.com/rightup/pyMC_core.git@${BRANCH}"
    
    log_success "pymc_core installed"
}

install_pymc_repeater() {
    log_info "Cloning pyMC_Repeater@${BRANCH}..."
    
    if [[ -d "${REPEATER_DIR}" ]]; then
        log_warn "Repeater directory exists, updating..."
        cd "${REPEATER_DIR}"
        git fetch origin
        git checkout "${BRANCH}"
        git pull origin "${BRANCH}"
    else
        git clone -b "${BRANCH}" https://github.com/rightup/pyMC_Repeater.git "${REPEATER_DIR}"
    fi
    
    log_info "Installing pyMC_Repeater..."
    cd "${REPEATER_DIR}"
    pip install -e .
    
    log_success "pyMC_Repeater installed"
}

install_frontend() {
    log_info "Installing Next.js frontend..."
    
    # Copy frontend to install directory
    if [[ -d "${INSTALL_DIR}/frontend" ]]; then
        log_warn "Frontend directory exists, removing..."
        rm -rf "${INSTALL_DIR}/frontend"
    fi
    
    cp -r "${SCRIPT_DIR}/frontend" "${INSTALL_DIR}/frontend"
    
    cd "${INSTALL_DIR}/frontend"
    npm ci
    npm run build
    
    log_success "Frontend installed and built"
}

setup_monitoring() {
    log_info "Setting up monitoring configuration..."
    
    # Copy monitoring configs
    cp -r "${SCRIPT_DIR}/monitoring" "${INSTALL_DIR}/monitoring"
    cp "${SCRIPT_DIR}/docker-compose.yml" "${INSTALL_DIR}/docker-compose.yml"
    
    log_success "Monitoring configuration copied"
}

create_env_file() {
    log_info "Creating frontend environment file..."
    
    if [[ ! -f "${INSTALL_DIR}/frontend/.env.local" ]]; then
        cp "${INSTALL_DIR}/frontend/.env.example" "${INSTALL_DIR}/frontend/.env.local"
        log_success "Created .env.local (edit to configure API URL)"
    else
        log_warn ".env.local already exists, skipping"
    fi
}

print_next_steps() {
    echo ""
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║                 Installation Complete!                    ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo ""
    echo "Next steps:"
    echo ""
    echo "1. Configure the repeater:"
    echo "   cp ${REPEATER_DIR}/config.yaml.example /etc/pymc_repeater/config.yaml"
    echo "   # Edit /etc/pymc_repeater/config.yaml with your settings"
    echo ""
    echo "2. Configure the frontend API URL:"
    echo "   # Edit ${INSTALL_DIR}/frontend/.env.local"
    echo "   # Set NEXT_PUBLIC_API_URL to your repeater's address"
    echo ""
    echo "3. Run the repeater daemon:"
    echo "   source ${INSTALL_DIR}/venv/bin/activate"
    echo "   cd ${REPEATER_DIR} && python -m repeater.main"
    echo ""
    echo "4. Run the frontend (in another terminal):"
    echo "   cd ${INSTALL_DIR}/frontend && npm run start"
    echo "   # Dashboard available at http://localhost:3000"
    echo ""
    echo "5. (Optional) Start monitoring stack:"
    echo "   cd ${INSTALL_DIR} && docker-compose up -d"
    echo "   # Grafana at http://localhost:3002 (admin/admin)"
    echo "   # Prometheus at http://localhost:9090"
    echo ""
    echo "For systemd service setup, run:"
    echo "   sudo ${REPEATER_DIR}/manage.sh"
    echo ""
}

# Main installation flow
main() {
    print_banner
    
    # Create install directory
    if [[ ! -d "${INSTALL_DIR}" ]]; then
        log_info "Creating install directory: ${INSTALL_DIR}"
        sudo mkdir -p "${INSTALL_DIR}"
        sudo chown "$(whoami):$(id -gn)" "${INSTALL_DIR}"
    fi
    
    check_dependencies
    create_virtualenv
    install_pymc_core
    install_pymc_repeater
    install_frontend
    setup_monitoring
    create_env_file
    print_next_steps
}

main "$@"
