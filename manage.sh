#!/bin/bash
# pyMC Console Management Script
# Install, Upgrade, Configure, and Manage pymc_console stack

set -e

# Installation paths
INSTALL_DIR="/opt/pymc_console"
CONFIG_DIR="/etc/pymc_repeater"
LOG_DIR="/var/log/pymc_repeater"
FRONTEND_DIR="$INSTALL_DIR/frontend"
REPEATER_DIR="$INSTALL_DIR/pymc_repeater"
SERVICE_USER="repeater"

# Service names
BACKEND_SERVICE="pymc-repeater"
FRONTEND_SERVICE="pymc-frontend"

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default branch for installations
DEFAULT_BRANCH="dev"

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

# Status indicators
CHECK="${GREEN}✓${NC}"
CROSS="${RED}✗${NC}"
ARROW="${CYAN}➜${NC}"
SPINNER_CHARS='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

# ============================================================================
# Progress Display Functions
# ============================================================================

# Print a step header
print_step() {
    local step_num="$1"
    local total_steps="$2"
    local description="$3"
    echo ""
    echo -e "${BOLD}${CYAN}[$step_num/$total_steps]${NC} ${BOLD}$description${NC}"
}

# Print success message
print_success() {
    echo -e "        ${CHECK} $1"
}

# Print error message
print_error() {
    echo -e "        ${CROSS} ${RED}$1${NC}"
}

# Print info message
print_info() {
    echo -e "        ${ARROW} $1"
}

# Print warning message
print_warning() {
    echo -e "        ${YELLOW}⚠${NC} $1"
}

# Run a command with spinner and capture output
run_with_spinner() {
    local description="$1"
    shift
    local cmd="$@"
    local log_file=$(mktemp)
    local pid
    local i=0
    
    # Start command in background
    eval "$cmd" > "$log_file" 2>&1 &
    pid=$!
    
    # Show spinner while command runs
    printf "        ${DIM}%s${NC} " "$description"
    while kill -0 $pid 2>/dev/null; do
        printf "\r        ${CYAN}%s${NC} %s" "${SPINNER_CHARS:i++%${#SPINNER_CHARS}:1}" "$description"
        sleep 0.1
    done
    
    # Get exit status
    wait $pid
    local exit_code=$?
    
    # Clear spinner line and show result
    printf "\r        "  # Clear the line
    if [ $exit_code -eq 0 ]; then
        echo -e "${CHECK} $description"
        rm -f "$log_file"
        return 0
    else
        echo -e "${CROSS} ${RED}$description${NC}"
        echo -e "        ${DIM}Log output:${NC}"
        tail -20 "$log_file" | sed 's/^/        /' 
        rm -f "$log_file"
        return 1
    fi
}

# Run a command and show immediate output (for long operations)
run_with_output() {
    local description="$1"
    shift
    local cmd="$@"
    
    echo -e "        ${ARROW} $description"
    echo -e "        ${DIM}─────────────────────────────────────────${NC}"
    
    # Run command with indented output
    if eval "$cmd" 2>&1 | sed 's/^/        /'; then
        echo -e "        ${DIM}─────────────────────────────────────────${NC}"
        print_success "$description completed"
        return 0
    else
        echo -e "        ${DIM}─────────────────────────────────────────${NC}"
        print_error "$description failed"
        return 1
    fi
}

# Show a progress bar (updates in place)
# Usage: show_progress_bar current total [description]
show_progress_bar() {
    local current=$1
    local total=$2
    local description="${3:-}"
    local width=30
    local percent=$((current * 100 / total))
    local filled=$((current * width / total))
    local empty=$((width - filled))
    
    # Build the bar
    local bar=""
    for ((i=0; i<filled; i++)); do bar+="█"; done
    for ((i=0; i<empty; i++)); do bar+="░"; done
    
    # Print with carriage return to update in place
    printf "\r        ${CYAN}[${bar}]${NC} ${percent}%% ${DIM}${description}${NC}  "
}

# Run a long command with elapsed time display
run_with_elapsed_time() {
    local description="$1"
    shift
    local cmd="$@"
    local log_file=$(mktemp)
    local pid
    local start_time=$(date +%s)
    
    # Start command in background
    eval "$cmd" > "$log_file" 2>&1 &
    pid=$!
    
    # Show elapsed time while command runs
    printf "        ${ARROW} %s " "$description"
    while kill -0 $pid 2>/dev/null; do
        local elapsed=$(($(date +%s) - start_time))
        local mins=$((elapsed / 60))
        local secs=$((elapsed % 60))
        printf "\r        ${CYAN}⏱${NC}  %s ${DIM}(%dm %02ds)${NC}  " "$description" $mins $secs
        sleep 1
    done
    
    # Get exit status
    wait $pid
    local exit_code=$?
    local elapsed=$(($(date +%s) - start_time))
    local mins=$((elapsed / 60))
    local secs=$((elapsed % 60))
    
    # Clear line and show result
    printf "\r        "  # Clear
    if [ $exit_code -eq 0 ]; then
        echo -e "${CHECK} $description ${DIM}(${mins}m ${secs}s)${NC}"
        rm -f "$log_file"
        return 0
    else
        echo -e "${CROSS} ${RED}$description${NC} ${DIM}(${mins}m ${secs}s)${NC}"
        echo -e "        ${DIM}Log output:${NC}"
        tail -20 "$log_file" | sed 's/^/        /' 
        rm -f "$log_file"
        return 1
    fi
}

# Print installation banner
print_banner() {
    clear
    echo ""
    echo -e "${BOLD}${CYAN}pyMC Console Installer${NC}"
    echo -e "${DIM}Next.js Dashboard + LoRa Mesh Network Repeater${NC}"
    echo ""
}

# Print completion summary
print_completion() {
    local ip_address="$1"
    echo ""
    echo -e "${GREEN}${BOLD}Installation Complete!${NC} ${CHECK}"
    echo ""
    
    # Disk usage report
    echo -e "${BOLD}Disk Usage:${NC}"
    local install_size=$(du -sh "$INSTALL_DIR" 2>/dev/null | cut -f1 || echo "N/A")
    local config_size=$(du -sh "$CONFIG_DIR" 2>/dev/null | cut -f1 || echo "N/A")
    local total_size=$(du -sh "$INSTALL_DIR" "$CONFIG_DIR" 2>/dev/null | tail -1 | cut -f1 || echo "N/A")
    echo -e "  ${DIM}Installation:${NC}  $install_size"
    echo -e "  ${DIM}Configuration:${NC} $config_size"
    echo ""
    
    echo -e "${BOLD}Access your dashboard:${NC}"
    echo -e "  ${ARROW} Web UI:  ${CYAN}http://$ip_address:3000${NC}"
    echo -e "  ${ARROW} API:     ${CYAN}http://$ip_address:8000${NC}"
    echo ""
}

# Cleanup function for error handling
cleanup_on_error() {
    echo ""
    print_error "Installation failed!"
    echo ""
    echo -e "  ${YELLOW}Partial installation may remain. To clean up:${NC}"
    echo -e "  ${DIM}sudo ./manage.sh uninstall${NC}"
    echo ""
    echo -e "  ${YELLOW}Check the error messages above for details.${NC}"
    echo -e "  ${YELLOW}Common issues:${NC}"
    echo -e "  ${DIM}- Network connectivity problems${NC}"
    echo -e "  ${DIM}- Missing system dependencies${NC}"
    echo -e "  ${DIM}- Insufficient disk space${NC}"
    echo -e "  ${DIM}- Permission issues${NC}"
    echo ""
}

# ============================================================================
# TUI Setup
# ============================================================================

# Check if running in interactive terminal
check_terminal() {
    if [ ! -t 0 ] || [ -z "$TERM" ]; then
        echo "Error: This script requires an interactive terminal."
        echo "Please run from SSH or a local terminal."
        exit 1
    fi
}

# Setup dialog/whiptail
setup_dialog() {
    if command -v whiptail &> /dev/null; then
        DIALOG="whiptail"
    elif command -v dialog &> /dev/null; then
        DIALOG="dialog"
    else
        echo "TUI interface requires whiptail or dialog."
        if [ "$EUID" -eq 0 ]; then
            echo "Installing whiptail..."
            apt-get update -qq && apt-get install -y whiptail
            DIALOG="whiptail"
        else
            echo ""
            echo "Please install whiptail: sudo apt-get install -y whiptail"
            exit 1
        fi
    fi
}

# ============================================================================
# Dialog Helper Functions
# ============================================================================

show_info() {
    $DIALOG --backtitle "pyMC Console Management" --title "$1" --msgbox "$2" 14 70
}

show_error() {
    $DIALOG --backtitle "pyMC Console Management" --title "Error" --msgbox "$1" 10 60
}

ask_yes_no() {
    $DIALOG --backtitle "pyMC Console Management" --title "$1" --yesno "$2" 12 70
}

get_input() {
    local title="$1"
    local prompt="$2"
    local default="$3"
    $DIALOG --backtitle "pyMC Console Management" --title "$title" --inputbox "$prompt" 10 70 "$default" 3>&1 1>&2 2>&3
}

# ============================================================================
# Status Check Functions
# ============================================================================

is_installed() {
    [ -d "$INSTALL_DIR" ] && [ -d "$REPEATER_DIR" ]
}

backend_running() {
    systemctl is-active "$BACKEND_SERVICE" >/dev/null 2>&1
}

frontend_running() {
    systemctl is-active "$FRONTEND_SERVICE" >/dev/null 2>&1
}

get_version() {
    if [ -f "$REPEATER_DIR/pyproject.toml" ]; then
        grep "^version" "$REPEATER_DIR/pyproject.toml" | cut -d'"' -f2 2>/dev/null || echo "unknown"
    else
        echo "not installed"
    fi
}

get_status_display() {
    if ! is_installed; then
        echo "Not Installed"
    else
        local version=$(get_version)
        local backend_status="Stopped"
        local frontend_status="Stopped"
        
        backend_running && backend_status="Running"
        frontend_running && frontend_status="Running"
        
        echo "v$version | Backend: $backend_status | Frontend: $frontend_status"
    fi
}

# ============================================================================
# Install Function
# ============================================================================

do_install() {
    # Check if already installed
    if is_installed; then
        show_error "pyMC Console is already installed!\n\nInstallation directory: $INSTALL_DIR\n\nUse 'upgrade' to update or 'uninstall' first."
        return 1
    fi
    
    # Check root
    if [ "$EUID" -ne 0 ]; then
        show_error "Installation requires root privileges.\n\nPlease run: sudo $0 install"
        return 1
    fi
    
    # Branch selection
    local branch="${1:-}"
    if [ -z "$branch" ]; then
        branch=$($DIALOG --backtitle "pyMC Console Management" --title "Select Branch" --menu "\nSelect the branch to install from:" 14 60 4 \
            "dev" "Development branch (recommended)" \
            "main" "Stable release" \
            "custom" "Enter custom branch name" 3>&1 1>&2 2>&3)
        
        if [ -z "$branch" ]; then
            return 0  # User cancelled
        fi
        
        if [ "$branch" = "custom" ]; then
            branch=$(get_input "Custom Branch" "Enter the branch name:" "dev")
            if [ -z "$branch" ]; then
                return 0
            fi
        fi
    fi
    
    # Welcome screen
    $DIALOG --backtitle "pyMC Console Management" --title "Welcome" --msgbox "\nWelcome to pyMC Console Setup\n\nThis will install:\n- pyMC Repeater (LoRa mesh repeater)\n- pyMC Console (Next.js dashboard)\n- Monitoring stack (Prometheus/Grafana configs)\n\nBranch: $branch\nInstall directory: $INSTALL_DIR\n\nPress OK to continue..." 16 70
    
    # SPI Check (Raspberry Pi)
    check_spi
    
    # Set up error handling
    trap cleanup_on_error ERR
    
    # Print banner
    print_banner
    echo -e "  ${DIM}Branch: $branch${NC}"
    echo -e "  ${DIM}Install directory: $INSTALL_DIR${NC}"
    
    local total_steps=10
    
    # =========================================================================
    # Step 1: Create service user
    # =========================================================================
    print_step 1 $total_steps "Creating service user"
    
    if id "$SERVICE_USER" &>/dev/null; then
        print_info "User '$SERVICE_USER' already exists"
    else
        if useradd --system --home /var/lib/pymc_repeater --shell /sbin/nologin "$SERVICE_USER" 2>/dev/null; then
            print_success "Created user '$SERVICE_USER'"
        else
            print_error "Failed to create user '$SERVICE_USER'"
            return 1
        fi
    fi
    
    usermod -a -G gpio,i2c,spi "$SERVICE_USER" 2>/dev/null || true
    usermod -a -G dialout "$SERVICE_USER" 2>/dev/null || true
    print_success "Added user to hardware groups"
    
    # =========================================================================
    # Step 2: Create directories
    # =========================================================================
    print_step 2 $total_steps "Creating directories"
    
    mkdir -p "$INSTALL_DIR" && print_success "$INSTALL_DIR"
    mkdir -p "$CONFIG_DIR" && print_success "$CONFIG_DIR"
    mkdir -p "$LOG_DIR" && print_success "$LOG_DIR"
    mkdir -p /var/lib/pymc_repeater && print_success "/var/lib/pymc_repeater"
    mkdir -p "$FRONTEND_DIR" && print_success "$FRONTEND_DIR"
    
    # =========================================================================
    # Step 3: Install system dependencies
    # =========================================================================
    print_step 3 $total_steps "Installing system dependencies"
    
    run_with_spinner "Updating package lists" "apt-get update -qq" || {
        print_error "Failed to update package lists"
        return 1
    }
    
    run_with_spinner "Installing required packages" "apt-get install -y libffi-dev jq python3-pip python3-venv python3-rrdtool wget swig build-essential python3-dev curl git" || {
        print_error "Failed to install system packages"
        return 1
    }
    
    # Install yq
    if ! command -v yq &> /dev/null || [[ "$(yq --version 2>&1)" != *"mikefarah/yq"* ]]; then
        run_with_spinner "Installing yq" "install_yq_silent" || print_warning "yq installation failed (non-critical)"
    else
        print_success "yq already installed"
    fi
    
    # =========================================================================
    # Step 4: Create Python virtual environment
    # =========================================================================
    print_step 4 $total_steps "Setting up Python environment"
    
    run_with_spinner "Creating virtual environment" "python3 -m venv '$INSTALL_DIR/venv'" || {
        print_error "Failed to create virtual environment"
        return 1
    }
    
    source "$INSTALL_DIR/venv/bin/activate"
    
    run_with_spinner "Upgrading pip" "pip install --upgrade pip wheel setuptools" || {
        print_error "Failed to upgrade pip"
        return 1
    }
    
    # =========================================================================
    # Step 5: Install pymc_core
    # =========================================================================
    print_step 5 $total_steps "Installing pymc_core@$branch"
    
    run_with_elapsed_time "Downloading and installing pymc_core" "pip install 'pymc_core[hardware] @ git+https://github.com/rightup/pyMC_core.git@$branch'" || {
        print_error "Failed to install pymc_core"
        print_info "Check if branch '$branch' exists and network is available"
        return 1
    }
    
    # =========================================================================
    # Step 6: Clone and install pyMC_Repeater
    # =========================================================================
    print_step 6 $total_steps "Installing pyMC_Repeater@$branch"
    
    run_with_elapsed_time "Cloning repository" "git clone -b '$branch' https://github.com/rightup/pyMC_Repeater.git '$REPEATER_DIR'" || {
        print_error "Failed to clone pyMC_Repeater"
        print_info "Check if branch '$branch' exists"
        return 1
    }
    
    cd "$REPEATER_DIR"
    
    run_with_elapsed_time "Installing Python package" "pip install -e ." || {
        print_error "Failed to install pyMC_Repeater package"
        return 1
    }
    
    # =========================================================================
    # Step 7: Setup configuration
    # =========================================================================
    print_step 7 $total_steps "Setting up configuration"
    
    cp "$REPEATER_DIR/config.yaml.example" "$CONFIG_DIR/config.yaml.example" && \
        print_success "Copied example configuration"
    
    if [ ! -f "$CONFIG_DIR/config.yaml" ]; then
        cp "$REPEATER_DIR/config.yaml.example" "$CONFIG_DIR/config.yaml"
        print_success "Created config.yaml"
    else
        print_info "config.yaml already exists, preserving"
    fi
    
    # Copy radio settings files
    if [ -f "$REPEATER_DIR/radio-settings.json" ]; then
        cp "$REPEATER_DIR/radio-settings.json" "$INSTALL_DIR/"
        print_success "Copied radio-settings.json"
    fi
    
    if [ -f "$REPEATER_DIR/radio-presets.json" ]; then
        cp "$REPEATER_DIR/radio-presets.json" "$INSTALL_DIR/"
        print_success "Copied radio-presets.json"
    fi
    
    # =========================================================================
    # Step 8: Create backend systemd service
    # =========================================================================
    print_step 8 $total_steps "Creating backend service"
    
    create_backend_service
    print_success "Created pymc-repeater.service"
    
    # =========================================================================
    # Step 9: Install Next.js frontend
    # =========================================================================
    print_step 9 $total_steps "Installing Next.js frontend"
    
    install_frontend_files_with_progress || {
        print_error "Frontend installation failed"
        return 1
    }
    
    # =========================================================================
    # Step 10: Finalize and start services
    # =========================================================================
    print_step 10 $total_steps "Finalizing installation"
    
    print_info "Setting permissions..."
    chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR" "$CONFIG_DIR" "$LOG_DIR" /var/lib/pymc_repeater
    chmod 750 "$CONFIG_DIR" "$LOG_DIR"
    print_success "Permissions configured"
    
    print_info "Enabling services..."
    systemctl daemon-reload
    systemctl enable "$BACKEND_SERVICE" "$FRONTEND_SERVICE" >/dev/null 2>&1
    print_success "Services enabled"
    
    print_info "Starting backend service..."
    if systemctl start "$BACKEND_SERVICE"; then
        sleep 2
        if backend_running; then
            print_success "Backend service running"
        else
            print_warning "Backend service started but may not be healthy"
        fi
    else
        print_warning "Backend service failed to start (configure radio settings first)"
    fi
    
    print_info "Starting frontend service..."
    if systemctl start "$FRONTEND_SERVICE"; then
        sleep 2
        if frontend_running; then
            print_success "Frontend service running"
        else
            print_warning "Frontend service started but may not be healthy"
        fi
    else
        print_error "Frontend service failed to start"
    fi
    
    # Clear error trap
    trap - ERR
    
    # =========================================================================
    # Radio Configuration (terminal-based)
    # =========================================================================
    echo ""
    echo -e "${BOLD}${CYAN}Radio Configuration${NC}"
    echo -e "${DIM}Configure your radio settings for your region and hardware${NC}"
    echo ""
    
    configure_radio_terminal
    
    # Restart backend with new config
    print_info "Applying configuration..."
    systemctl restart "$BACKEND_SERVICE" 2>/dev/null || true
    sleep 2
    if backend_running; then
        print_success "Backend service running with new configuration"
    else
        print_warning "Backend may need GPIO configuration - use './manage.sh gpio'"
    fi
    
    # Show completion
    local ip_address=$(hostname -I | awk '{print $1}')
    print_completion "$ip_address"
    
    echo -e "${BOLD}Manage your installation:${NC}"
    echo -e "  ${DIM}./manage.sh settings${NC}  - Configure radio"
    echo -e "  ${DIM}./manage.sh gpio${NC}      - Configure GPIO pins"
    echo -e "  ${DIM}./manage.sh${NC}           - Full management menu"
    echo ""
}

# ============================================================================
# Upgrade Function
# ============================================================================

do_upgrade() {
    if ! is_installed; then
        show_error "pyMC Console is not installed!\n\nUse 'install' first."
        return 1
    fi
    
    if [ "$EUID" -ne 0 ]; then
        show_error "Upgrade requires root privileges.\n\nPlease run: sudo $0 upgrade"
        return 1
    fi
    
    local current_version=$(get_version)
    
    if ! ask_yes_no "Confirm Upgrade" "Current version: $current_version\n\nThis will:\n- Update pyMC_Repeater from git\n- Rebuild the frontend\n- Preserve your configuration\n\nContinue?"; then
        return 0
    fi
    
    clear
    echo "=== pyMC Console Upgrade ==="
    echo ""
    
    echo "[1/8] Stopping services..."
    systemctl stop "$FRONTEND_SERVICE" 2>/dev/null || true
    systemctl stop "$BACKEND_SERVICE" 2>/dev/null || true
    
    echo "[2/8] Backing up configuration..."
    local backup_file="$CONFIG_DIR/config.yaml.backup.$(date +%Y%m%d_%H%M%S)"
    cp "$CONFIG_DIR/config.yaml" "$backup_file"
    echo "    Backup saved to: $backup_file"
    
    echo "[3/8] Updating pyMC_Repeater..."
    cd "$REPEATER_DIR"
    git fetch origin
    git pull origin $(git rev-parse --abbrev-ref HEAD)
    
    echo "[4/8] Updating Python packages..."
    source "$INSTALL_DIR/venv/bin/activate"
    pip install --upgrade "pymc_core[hardware] @ git+https://github.com/rightup/pyMC_core.git@$(git rev-parse --abbrev-ref HEAD)"
    pip install -e .
    
    echo "[5/8] Merging configuration..."
    merge_config "$CONFIG_DIR/config.yaml" "$REPEATER_DIR/config.yaml.example"
    
    echo "[6/8] Updating frontend..."
    cp -r "$SCRIPT_DIR/frontend/"* "$FRONTEND_DIR/" 2>/dev/null || true
    rebuild_frontend
    
    echo "[7/8] Updating systemd services..."
    create_backend_service
    create_frontend_service
    systemctl daemon-reload
    
    echo "[8/8] Starting services..."
    systemctl start "$BACKEND_SERVICE"
    sleep 2
    systemctl start "$FRONTEND_SERVICE"
    
    local new_version=$(get_version)
    echo ""
    echo "=== Upgrade Complete ==="
    echo "Version: $current_version → $new_version"
    
    show_info "Upgrade Complete" "\nUpgrade completed successfully!\n\nVersion: $current_version → $new_version\n\n✓ Configuration preserved\n✓ Services restarted"
}

# ============================================================================
# Terminal-based Radio Configuration (for install flow)
# ============================================================================

configure_radio_terminal() {
    local config_file="$CONFIG_DIR/config.yaml"
    
    if [ ! -f "$config_file" ]; then
        print_warning "Config file not found, skipping radio configuration"
        return 0
    fi
    
    # Node name
    local current_name=$(yq '.repeater.node_name' "$config_file" 2>/dev/null || echo "mesh-repeater")
    local random_suffix=$(printf "%04d" $((RANDOM % 10000)))
    local default_name="pyRpt${random_suffix}"
    
    if [ "$current_name" = "mesh-repeater-01" ] || [ "$current_name" = "mesh-repeater" ]; then
        current_name="$default_name"
    fi
    
    echo -e "  ${BOLD}Node Name${NC}"
    read -p "  Enter repeater name [$current_name]: " node_name
    node_name=${node_name:-$current_name}
    yq -i ".repeater.node_name = \"$node_name\"" "$config_file"
    print_success "Node name: $node_name"
    echo ""
    
    # Radio preset selection
    echo -e "  ${BOLD}Radio Preset${NC}"
    echo -e "  ${DIM}Select a preset or choose custom to enter manual values${NC}"
    echo ""
    
    # Fetch presets
    local presets_json=""
    presets_json=$(curl -s --max-time 5 https://api.meshcore.nz/api/v1/config 2>/dev/null)
    
    if [ -z "$presets_json" ]; then
        if [ -f "$INSTALL_DIR/radio-presets.json" ]; then
            presets_json=$(cat "$INSTALL_DIR/radio-presets.json")
        elif [ -f "$REPEATER_DIR/radio-presets.json" ]; then
            presets_json=$(cat "$REPEATER_DIR/radio-presets.json")
        fi
    fi
    
    local preset_count=0
    local preset_titles=()
    local preset_freqs=()
    local preset_sfs=()
    local preset_bws=()
    local preset_crs=()
    
    if [ -n "$presets_json" ]; then
        while IFS= read -r line; do
            local title=$(echo "$line" | jq -r '.title')
            local freq=$(echo "$line" | jq -r '.frequency')
            local sf=$(echo "$line" | jq -r '.spreading_factor')
            local bw=$(echo "$line" | jq -r '.bandwidth')
            local cr=$(echo "$line" | jq -r '.coding_rate')
            
            if [ -n "$title" ] && [ "$title" != "null" ]; then
                ((preset_count++))
                preset_titles+=("$title")
                preset_freqs+=("$freq")
                preset_sfs+=("$sf")
                preset_bws+=("$bw")
                preset_crs+=("$cr")
                echo -e "  ${CYAN}$preset_count)${NC} $title ${DIM}(${freq}MHz SF$sf BW${bw}kHz)${NC}"
            fi
        done < <(echo "$presets_json" | jq -c '.[]' 2>/dev/null)
    fi
    
    echo -e "  ${CYAN}C)${NC} Custom ${DIM}(enter values manually)${NC}"
    echo ""
    
    read -p "  Select preset [1-$preset_count] or C for custom: " preset_choice
    
    local freq_mhz bw_khz sf cr
    
    if [[ "$preset_choice" =~ ^[Cc]$ ]]; then
        # Custom values
        echo ""
        echo -e "  ${BOLD}Custom Radio Settings${NC}"
        
        local current_freq=$(yq '.radio.frequency' "$config_file" 2>/dev/null || echo "869618000")
        local current_freq_mhz=$(awk "BEGIN {printf \"%.3f\", $current_freq / 1000000}")
        read -p "  Frequency in MHz [$current_freq_mhz]: " freq_mhz
        freq_mhz=${freq_mhz:-$current_freq_mhz}
        
        local current_sf=$(yq '.radio.spreading_factor' "$config_file" 2>/dev/null || echo "8")
        read -p "  Spreading Factor (7-12) [$current_sf]: " sf
        sf=${sf:-$current_sf}
        
        local current_bw=$(yq '.radio.bandwidth' "$config_file" 2>/dev/null || echo "62500")
        local current_bw_khz=$(awk "BEGIN {printf \"%.1f\", $current_bw / 1000}")
        read -p "  Bandwidth in kHz [$current_bw_khz]: " bw_khz
        bw_khz=${bw_khz:-$current_bw_khz}
        
        local current_cr=$(yq '.radio.coding_rate' "$config_file" 2>/dev/null || echo "8")
        read -p "  Coding Rate (5-8) [$current_cr]: " cr
        cr=${cr:-$current_cr}
    elif [[ "$preset_choice" =~ ^[0-9]+$ ]] && [ "$preset_choice" -ge 1 ] && [ "$preset_choice" -le "$preset_count" ]; then
        # Use preset
        local idx=$((preset_choice - 1))
        freq_mhz="${preset_freqs[$idx]}"
        sf="${preset_sfs[$idx]}"
        bw_khz="${preset_bws[$idx]}"
        cr="${preset_crs[$idx]}"
        print_success "Using preset: ${preset_titles[$idx]}"
    else
        print_warning "Invalid selection, keeping current settings"
        return 0
    fi
    
    # Apply settings
    local freq_hz=$(awk "BEGIN {printf \"%.0f\", $freq_mhz * 1000000}")
    local bw_hz=$(awk "BEGIN {printf \"%.0f\", $bw_khz * 1000}")
    
    yq -i ".radio.frequency = $freq_hz" "$config_file"
    yq -i ".radio.spreading_factor = $sf" "$config_file"
    yq -i ".radio.bandwidth = $bw_hz" "$config_file"
    yq -i ".radio.coding_rate = $cr" "$config_file"
    
    echo ""
    print_success "Radio: ${freq_mhz}MHz SF$sf BW${bw_khz}kHz CR$cr"
    
    # TX Power
    echo ""
    local current_power=$(yq '.radio.tx_power' "$config_file" 2>/dev/null || echo "14")
    read -p "  TX Power in dBm [$current_power]: " tx_power
    tx_power=${tx_power:-$current_power}
    yq -i ".radio.tx_power = $tx_power" "$config_file"
    print_success "TX Power: ${tx_power}dBm"
    
    echo ""
    
    # Hardware selection
    echo -e "  ${BOLD}Hardware Selection${NC}"
    echo -e "  ${DIM}Select your LoRa hardware for GPIO configuration${NC}"
    echo ""
    
    configure_hardware_terminal "$config_file"
}

# Terminal-based hardware/GPIO configuration
configure_hardware_terminal() {
    local config_file="${1:-$CONFIG_DIR/config.yaml}"
    local hw_config=""
    
    # Find hardware presets file
    if [ -f "$INSTALL_DIR/radio-settings.json" ]; then
        hw_config="$INSTALL_DIR/radio-settings.json"
    elif [ -f "$REPEATER_DIR/radio-settings.json" ]; then
        hw_config="$REPEATER_DIR/radio-settings.json"
    fi
    
    if [ -z "$hw_config" ] || [ ! -f "$hw_config" ]; then
        print_warning "Hardware presets not found, skipping GPIO configuration"
        print_info "Configure GPIO manually with: ./manage.sh gpio"
        return 0
    fi
    
    # Build hardware options
    local hw_count=0
    local hw_keys=()
    local hw_names=()
    
    while IFS= read -r key; do
        local name=$(jq -r ".hardware.\"$key\".name" "$hw_config" 2>/dev/null)
        if [ -n "$name" ] && [ "$name" != "null" ]; then
            ((hw_count++))
            hw_keys+=("$key")
            hw_names+=("$name")
            echo -e "  ${CYAN}$hw_count)${NC} $name"
        fi
    done < <(jq -r '.hardware | keys[]' "$hw_config" 2>/dev/null)
    
    echo -e "  ${CYAN}C)${NC} Custom GPIO ${DIM}(enter pins manually)${NC}"
    echo ""
    
    read -p "  Select hardware [1-$hw_count] or C for custom: " hw_choice
    
    if [[ "$hw_choice" =~ ^[Cc]$ ]]; then
        # Custom GPIO
        echo ""
        echo -e "  ${BOLD}Custom GPIO Configuration${NC} ${YELLOW}(BCM pin numbering)${NC}"
        
        local current_cs=$(yq '.sx1262.cs_pin' "$config_file" 2>/dev/null || echo "21")
        read -p "  Chip Select pin [$current_cs]: " cs_pin
        cs_pin=${cs_pin:-$current_cs}
        
        local current_reset=$(yq '.sx1262.reset_pin' "$config_file" 2>/dev/null || echo "18")
        read -p "  Reset pin [$current_reset]: " reset_pin
        reset_pin=${reset_pin:-$current_reset}
        
        local current_busy=$(yq '.sx1262.busy_pin' "$config_file" 2>/dev/null || echo "20")
        read -p "  Busy pin [$current_busy]: " busy_pin
        busy_pin=${busy_pin:-$current_busy}
        
        local current_irq=$(yq '.sx1262.irq_pin' "$config_file" 2>/dev/null || echo "16")
        read -p "  IRQ pin [$current_irq]: " irq_pin
        irq_pin=${irq_pin:-$current_irq}
        
        local current_txen=$(yq '.sx1262.txen_pin' "$config_file" 2>/dev/null || echo "-1")
        read -p "  TX Enable pin (-1 to disable) [$current_txen]: " txen_pin
        txen_pin=${txen_pin:-$current_txen}
        
        local current_rxen=$(yq '.sx1262.rxen_pin' "$config_file" 2>/dev/null || echo "-1")
        read -p "  RX Enable pin (-1 to disable) [$current_rxen]: " rxen_pin
        rxen_pin=${rxen_pin:-$current_rxen}
        
        # Apply custom GPIO
        yq -i ".sx1262.cs_pin = $cs_pin" "$config_file"
        yq -i ".sx1262.reset_pin = $reset_pin" "$config_file"
        yq -i ".sx1262.busy_pin = $busy_pin" "$config_file"
        yq -i ".sx1262.irq_pin = $irq_pin" "$config_file"
        yq -i ".sx1262.txen_pin = $txen_pin" "$config_file"
        yq -i ".sx1262.rxen_pin = $rxen_pin" "$config_file"
        
        echo ""
        print_success "Custom GPIO: CS=$cs_pin RST=$reset_pin BUSY=$busy_pin IRQ=$irq_pin"
        
    elif [[ "$hw_choice" =~ ^[0-9]+$ ]] && [ "$hw_choice" -ge 1 ] && [ "$hw_choice" -le "$hw_count" ]; then
        # Use preset
        local idx=$((hw_choice - 1))
        local hw_key="${hw_keys[$idx]}"
        local hw_name="${hw_names[$idx]}"
        local preset=$(jq ".hardware.\"$hw_key\"" "$hw_config" 2>/dev/null)
        
        if [ -n "$preset" ] && [ "$preset" != "null" ]; then
            # Extract all GPIO settings
            local bus_id=$(echo "$preset" | jq -r '.bus_id // 0')
            local cs_id=$(echo "$preset" | jq -r '.cs_id // 0')
            local cs_pin=$(echo "$preset" | jq -r '.cs_pin // 21')
            local reset_pin=$(echo "$preset" | jq -r '.reset_pin // 18')
            local busy_pin=$(echo "$preset" | jq -r '.busy_pin // 20')
            local irq_pin=$(echo "$preset" | jq -r '.irq_pin // 16')
            local txen_pin=$(echo "$preset" | jq -r '.txen_pin // -1')
            local rxen_pin=$(echo "$preset" | jq -r '.rxen_pin // -1')
            local is_waveshare=$(echo "$preset" | jq -r '.is_waveshare // false')
            local use_dio3_tcxo=$(echo "$preset" | jq -r '.use_dio3_tcxo // false')
            local tx_power=$(echo "$preset" | jq -r '.tx_power // 22')
            local preamble_length=$(echo "$preset" | jq -r '.preamble_length // 17')
            
            # Apply to config
            yq -i ".sx1262.bus_id = $bus_id" "$config_file"
            yq -i ".sx1262.cs_id = $cs_id" "$config_file"
            yq -i ".sx1262.cs_pin = $cs_pin" "$config_file"
            yq -i ".sx1262.reset_pin = $reset_pin" "$config_file"
            yq -i ".sx1262.busy_pin = $busy_pin" "$config_file"
            yq -i ".sx1262.irq_pin = $irq_pin" "$config_file"
            yq -i ".sx1262.txen_pin = $txen_pin" "$config_file"
            yq -i ".sx1262.rxen_pin = $rxen_pin" "$config_file"
            yq -i ".sx1262.is_waveshare = $is_waveshare" "$config_file"
            yq -i ".sx1262.use_dio3_tcxo = $use_dio3_tcxo" "$config_file"
            yq -i ".radio.tx_power = $tx_power" "$config_file"
            yq -i ".radio.preamble_length = $preamble_length" "$config_file"
            
            echo ""
            print_success "Hardware: $hw_name"
            print_success "GPIO: CS=$cs_pin RST=$reset_pin BUSY=$busy_pin IRQ=$irq_pin"
            if [ "$txen_pin" != "-1" ]; then
                print_info "TX/RX Enable: TXEN=$txen_pin RXEN=$rxen_pin"
            fi
            print_info "TX Power: ${tx_power}dBm"
        fi
    else
        print_warning "Invalid selection, keeping current GPIO settings"
        print_info "Configure GPIO later with: ./manage.sh gpio"
    fi
    
    echo ""
}

# ============================================================================
# Settings Function (Radio Configuration) - TUI version for manage.sh menu
# ============================================================================

do_settings() {
    if [ ! -f "$CONFIG_DIR/config.yaml" ]; then
        show_error "Configuration file not found!\n\nPlease install pyMC Console first."
        return 1
    fi
    
    while true; do
        local current_name=$(yq '.repeater.node_name' "$CONFIG_DIR/config.yaml" 2>/dev/null || echo "unknown")
        local current_freq=$(yq '.radio.frequency' "$CONFIG_DIR/config.yaml" 2>/dev/null || echo "0")
        local current_freq_mhz=$(awk "BEGIN {printf \"%.3f\", $current_freq / 1000000}")
        local current_sf=$(yq '.radio.spreading_factor' "$CONFIG_DIR/config.yaml" 2>/dev/null || echo "0")
        local current_bw=$(yq '.radio.bandwidth' "$CONFIG_DIR/config.yaml" 2>/dev/null || echo "0")
        local current_bw_khz=$(awk "BEGIN {printf \"%.1f\", $current_bw / 1000}")
        local current_power=$(yq '.radio.tx_power' "$CONFIG_DIR/config.yaml" 2>/dev/null || echo "0")
        
        CHOICE=$($DIALOG --backtitle "pyMC Console Management" --title "Radio Settings" --menu "\nCurrent Configuration:\n  Name: $current_name\n  Freq: ${current_freq_mhz}MHz | SF$current_sf | BW${current_bw_khz}kHz | ${current_power}dBm\n\nSelect setting to change:" 20 70 8 \
            "name" "Node name ($current_name)" \
            "preset" "Load radio preset (frequency, SF, BW, CR)" \
            "frequency" "Frequency (${current_freq_mhz}MHz)" \
            "power" "TX Power (${current_power}dBm)" \
            "spreading" "Spreading Factor (SF$current_sf)" \
            "bandwidth" "Bandwidth (${current_bw_khz}kHz)" \
            "apply" "Apply changes and restart" \
            "back" "Back to main menu" 3>&1 1>&2 2>&3)
        
        case $CHOICE in
            "name")
                local new_name=$(get_input "Node Name" "Enter repeater node name:" "$current_name")
                if [ -n "$new_name" ]; then
                    yq -i ".repeater.node_name = \"$new_name\"" "$CONFIG_DIR/config.yaml"
                    show_info "Updated" "Node name set to: $new_name"
                fi
                ;;
            "preset")
                select_radio_preset
                ;;
            "frequency")
                local new_freq=$(get_input "Frequency" "Enter frequency in MHz (e.g., 869.618):" "$current_freq_mhz")
                if [ -n "$new_freq" ]; then
                    local freq_hz=$(awk "BEGIN {printf \"%.0f\", $new_freq * 1000000}")
                    yq -i ".radio.frequency = $freq_hz" "$CONFIG_DIR/config.yaml"
                    show_info "Updated" "Frequency set to: ${new_freq}MHz"
                fi
                ;;
            "power")
                local new_power=$(get_input "TX Power" "Enter TX power in dBm (e.g., 14):" "$current_power")
                if [ -n "$new_power" ]; then
                    yq -i ".radio.tx_power = $new_power" "$CONFIG_DIR/config.yaml"
                    show_info "Updated" "TX Power set to: ${new_power}dBm"
                fi
                ;;
            "spreading")
                local new_sf=$(get_input "Spreading Factor" "Enter spreading factor (7-12):" "$current_sf")
                if [ -n "$new_sf" ]; then
                    yq -i ".radio.spreading_factor = $new_sf" "$CONFIG_DIR/config.yaml"
                    show_info "Updated" "Spreading factor set to: SF$new_sf"
                fi
                ;;
            "bandwidth")
                local new_bw=$(get_input "Bandwidth" "Enter bandwidth in kHz (e.g., 62.5):" "$current_bw_khz")
                if [ -n "$new_bw" ]; then
                    local bw_hz=$(awk "BEGIN {printf \"%.0f\", $new_bw * 1000}")
                    yq -i ".radio.bandwidth = $bw_hz" "$CONFIG_DIR/config.yaml"
                    show_info "Updated" "Bandwidth set to: ${new_bw}kHz"
                fi
                ;;
            "apply")
                if [ "$EUID" -eq 0 ]; then
                    systemctl restart "$BACKEND_SERVICE" 2>/dev/null || true
                    sleep 2
                    if backend_running; then
                        show_info "Applied" "Configuration applied and service restarted successfully!"
                    else
                        show_error "Service failed to restart!\n\nCheck logs: journalctl -u $BACKEND_SERVICE"
                    fi
                else
                    show_info "Note" "Run as root to restart services automatically.\n\nManually restart with:\nsudo systemctl restart $BACKEND_SERVICE"
                fi
                ;;
            "back"|"")
                return 0
                ;;
        esac
    done
}

select_radio_preset() {
    # Fetch presets from API or use local file
    local presets_json=""
    
    echo "Fetching radio presets..." >&2
    presets_json=$(curl -s --max-time 5 https://api.meshcore.nz/api/v1/config 2>/dev/null)
    
    if [ -z "$presets_json" ]; then
        if [ -f "$INSTALL_DIR/radio-presets.json" ]; then
            presets_json=$(cat "$INSTALL_DIR/radio-presets.json")
        elif [ -f "$REPEATER_DIR/radio-presets.json" ]; then
            presets_json=$(cat "$REPEATER_DIR/radio-presets.json")
        else
            show_error "Could not fetch radio presets from API and no local file found."
            return 1
        fi
    fi
    
    # Build menu from presets
    local menu_items=()
    local index=1
    
    while IFS= read -r line; do
        local title=$(echo "$line" | jq -r '.title')
        local freq=$(echo "$line" | jq -r '.frequency')
        local sf=$(echo "$line" | jq -r '.spreading_factor')
        local bw=$(echo "$line" | jq -r '.bandwidth')
        menu_items+=("$index" "$title (${freq}MHz SF$sf BW$bw)")
        ((index++))
    done < <(echo "$presets_json" | jq -c '.[]' 2>/dev/null)
    
    if [ ${#menu_items[@]} -eq 0 ]; then
        show_error "No presets found in configuration."
        return 1
    fi
    
    local selection=$($DIALOG --backtitle "pyMC Console Management" --title "Radio Presets" --menu "Select a radio preset:" 20 70 10 "${menu_items[@]}" 3>&1 1>&2 2>&3)
    
    if [ -n "$selection" ]; then
        local preset=$(echo "$presets_json" | jq -c ".[$((selection-1))]" 2>/dev/null)
        
        if [ -n "$preset" ] && [ "$preset" != "null" ]; then
            local freq=$(echo "$preset" | jq -r '.frequency')
            local sf=$(echo "$preset" | jq -r '.spreading_factor')
            local bw=$(echo "$preset" | jq -r '.bandwidth')
            local cr=$(echo "$preset" | jq -r '.coding_rate')
            local title=$(echo "$preset" | jq -r '.title')
            
            local freq_hz=$(awk "BEGIN {printf \"%.0f\", $freq * 1000000}")
            local bw_hz=$(awk "BEGIN {printf \"%.0f\", $bw * 1000}")
            
            yq -i ".radio.frequency = $freq_hz" "$CONFIG_DIR/config.yaml"
            yq -i ".radio.spreading_factor = $sf" "$CONFIG_DIR/config.yaml"
            yq -i ".radio.bandwidth = $bw_hz" "$CONFIG_DIR/config.yaml"
            yq -i ".radio.coding_rate = $cr" "$CONFIG_DIR/config.yaml"
            
            show_info "Preset Applied" "Applied preset: $title\n\nFrequency: ${freq}MHz\nSpreading Factor: SF$sf\nBandwidth: ${bw}kHz\nCoding Rate: $cr\n\nRemember to apply changes to restart the service."
        fi
    fi
}

# ============================================================================
# GPIO Function (Advanced Hardware Configuration)
# ============================================================================

do_gpio() {
    # Show warning first
    if ! ask_yes_no "⚠️  Advanced Configuration" "\nWARNING: GPIO Configuration\n\nThese settings are for ADVANCED USERS ONLY.\n\nIncorrect GPIO settings can:\n- Prevent radio communication\n- Cause hardware damage\n- Make the repeater non-functional\n\nOnly proceed if you know your hardware pinout!\n\nContinue?"; then
        return 0
    fi
    
    if [ ! -f "$CONFIG_DIR/config.yaml" ]; then
        show_error "Configuration file not found!\n\nPlease install pyMC Console first."
        return 1
    fi
    
    while true; do
        # Read current GPIO settings
        local cs_pin=$(yq '.sx1262.cs_pin' "$CONFIG_DIR/config.yaml" 2>/dev/null || echo "-1")
        local reset_pin=$(yq '.sx1262.reset_pin' "$CONFIG_DIR/config.yaml" 2>/dev/null || echo "-1")
        local busy_pin=$(yq '.sx1262.busy_pin' "$CONFIG_DIR/config.yaml" 2>/dev/null || echo "-1")
        local irq_pin=$(yq '.sx1262.irq_pin' "$CONFIG_DIR/config.yaml" 2>/dev/null || echo "-1")
        local txen_pin=$(yq '.sx1262.txen_pin' "$CONFIG_DIR/config.yaml" 2>/dev/null || echo "-1")
        local rxen_pin=$(yq '.sx1262.rxen_pin' "$CONFIG_DIR/config.yaml" 2>/dev/null || echo "-1")
        
        CHOICE=$($DIALOG --backtitle "pyMC Console Management" --title "GPIO Configuration ⚠️" --menu "\nCurrent GPIO Pins (BCM numbering):\n  CS: $cs_pin | Reset: $reset_pin | Busy: $busy_pin\n  IRQ: $irq_pin | TXEN: $txen_pin | RXEN: $rxen_pin\n\nSelect option:" 20 70 8 \
            "preset" "Load hardware preset" \
            "cs" "Chip Select pin ($cs_pin)" \
            "reset" "Reset pin ($reset_pin)" \
            "busy" "Busy pin ($busy_pin)" \
            "irq" "IRQ pin ($irq_pin)" \
            "txen" "TX Enable pin ($txen_pin, -1=disabled)" \
            "rxen" "RX Enable pin ($rxen_pin, -1=disabled)" \
            "apply" "Apply changes and restart" \
            "back" "Back to main menu" 3>&1 1>&2 2>&3)
        
        case $CHOICE in
            "preset")
                select_hardware_preset
                ;;
            "cs")
                local new_pin=$(get_input "Chip Select Pin" "Enter CS pin (BCM numbering):" "$cs_pin")
                [ -n "$new_pin" ] && yq -i ".sx1262.cs_pin = $new_pin" "$CONFIG_DIR/config.yaml"
                ;;
            "reset")
                local new_pin=$(get_input "Reset Pin" "Enter Reset pin (BCM numbering):" "$reset_pin")
                [ -n "$new_pin" ] && yq -i ".sx1262.reset_pin = $new_pin" "$CONFIG_DIR/config.yaml"
                ;;
            "busy")
                local new_pin=$(get_input "Busy Pin" "Enter Busy pin (BCM numbering):" "$busy_pin")
                [ -n "$new_pin" ] && yq -i ".sx1262.busy_pin = $new_pin" "$CONFIG_DIR/config.yaml"
                ;;
            "irq")
                local new_pin=$(get_input "IRQ Pin" "Enter IRQ pin (BCM numbering):" "$irq_pin")
                [ -n "$new_pin" ] && yq -i ".sx1262.irq_pin = $new_pin" "$CONFIG_DIR/config.yaml"
                ;;
            "txen")
                local new_pin=$(get_input "TX Enable Pin" "Enter TXEN pin (-1 to disable):" "$txen_pin")
                [ -n "$new_pin" ] && yq -i ".sx1262.txen_pin = $new_pin" "$CONFIG_DIR/config.yaml"
                ;;
            "rxen")
                local new_pin=$(get_input "RX Enable Pin" "Enter RXEN pin (-1 to disable):" "$rxen_pin")
                [ -n "$new_pin" ] && yq -i ".sx1262.rxen_pin = $new_pin" "$CONFIG_DIR/config.yaml"
                ;;
            "apply")
                if [ "$EUID" -eq 0 ]; then
                    systemctl restart "$BACKEND_SERVICE" 2>/dev/null || true
                    sleep 2
                    if backend_running; then
                        show_info "Applied" "GPIO configuration applied and service restarted!"
                    else
                        show_error "Service failed to restart!\n\nGPIO settings may be incorrect.\nCheck logs: journalctl -u $BACKEND_SERVICE"
                    fi
                else
                    show_info "Note" "Run as root to restart services automatically."
                fi
                ;;
            "back"|"")
                return 0
                ;;
        esac
    done
}

select_hardware_preset() {
    local hw_config=""
    
    if [ -f "$INSTALL_DIR/radio-settings.json" ]; then
        hw_config="$INSTALL_DIR/radio-settings.json"
    elif [ -f "$REPEATER_DIR/radio-settings.json" ]; then
        hw_config="$REPEATER_DIR/radio-settings.json"
    else
        show_error "Hardware configuration file not found!"
        return 1
    fi
    
    # Build menu from hardware presets
    local menu_items=()
    
    while IFS= read -r key; do
        local name=$(jq -r ".hardware.\"$key\".name" "$hw_config")
        menu_items+=("$key" "$name")
    done < <(jq -r '.hardware | keys[]' "$hw_config" 2>/dev/null)
    
    if [ ${#menu_items[@]} -eq 0 ]; then
        show_error "No hardware presets found."
        return 1
    fi
    
    local selection=$($DIALOG --backtitle "pyMC Console Management" --title "Hardware Presets" --menu "Select your hardware:" 20 70 10 "${menu_items[@]}" 3>&1 1>&2 2>&3)
    
    if [ -n "$selection" ]; then
        local preset=$(jq ".hardware.\"$selection\"" "$hw_config" 2>/dev/null)
        
        if [ -n "$preset" ] && [ "$preset" != "null" ]; then
            # Apply all GPIO settings from preset
            local bus_id=$(echo "$preset" | jq -r '.bus_id // 0')
            local cs_id=$(echo "$preset" | jq -r '.cs_id // 0')
            local cs_pin=$(echo "$preset" | jq -r '.cs_pin // 21')
            local reset_pin=$(echo "$preset" | jq -r '.reset_pin // 18')
            local busy_pin=$(echo "$preset" | jq -r '.busy_pin // 20')
            local irq_pin=$(echo "$preset" | jq -r '.irq_pin // 16')
            local txen_pin=$(echo "$preset" | jq -r '.txen_pin // -1')
            local rxen_pin=$(echo "$preset" | jq -r '.rxen_pin // -1')
            local is_waveshare=$(echo "$preset" | jq -r '.is_waveshare // false')
            local use_dio3_tcxo=$(echo "$preset" | jq -r '.use_dio3_tcxo // false')
            local tx_power=$(echo "$preset" | jq -r '.tx_power // 14')
            
            yq -i ".sx1262.bus_id = $bus_id" "$CONFIG_DIR/config.yaml"
            yq -i ".sx1262.cs_id = $cs_id" "$CONFIG_DIR/config.yaml"
            yq -i ".sx1262.cs_pin = $cs_pin" "$CONFIG_DIR/config.yaml"
            yq -i ".sx1262.reset_pin = $reset_pin" "$CONFIG_DIR/config.yaml"
            yq -i ".sx1262.busy_pin = $busy_pin" "$CONFIG_DIR/config.yaml"
            yq -i ".sx1262.irq_pin = $irq_pin" "$CONFIG_DIR/config.yaml"
            yq -i ".sx1262.txen_pin = $txen_pin" "$CONFIG_DIR/config.yaml"
            yq -i ".sx1262.rxen_pin = $rxen_pin" "$CONFIG_DIR/config.yaml"
            yq -i ".sx1262.is_waveshare = $is_waveshare" "$CONFIG_DIR/config.yaml"
            yq -i ".sx1262.use_dio3_tcxo = $use_dio3_tcxo" "$CONFIG_DIR/config.yaml"
            yq -i ".radio.tx_power = $tx_power" "$CONFIG_DIR/config.yaml"
            
            local name=$(echo "$preset" | jq -r '.name')
            show_info "Preset Applied" "Applied hardware preset: $name\n\nGPIO Pins:\n  CS: $cs_pin | Reset: $reset_pin\n  Busy: $busy_pin | IRQ: $irq_pin\n  TXEN: $txen_pin | RXEN: $rxen_pin\n\nTX Power: ${tx_power}dBm\n\nRemember to apply changes to restart."
        fi
    fi
}

# ============================================================================
# Service Control Functions
# ============================================================================

do_start() {
    if [ "$EUID" -ne 0 ]; then
        show_error "Service control requires root privileges.\n\nPlease run: sudo $0 start"
        return 1
    fi
    
    echo "Starting services..."
    systemctl start "$BACKEND_SERVICE" 2>/dev/null || true
    sleep 2
    systemctl start "$FRONTEND_SERVICE" 2>/dev/null || true
    sleep 1
    
    local backend_status="✗"
    local frontend_status="✗"
    backend_running && backend_status="✓"
    frontend_running && frontend_status="✓"
    
    show_info "Services Started" "\nBackend: $backend_status\nFrontend: $frontend_status"
}

do_stop() {
    if [ "$EUID" -ne 0 ]; then
        show_error "Service control requires root privileges.\n\nPlease run: sudo $0 stop"
        return 1
    fi
    
    echo "Stopping services..."
    systemctl stop "$FRONTEND_SERVICE" 2>/dev/null || true
    systemctl stop "$BACKEND_SERVICE" 2>/dev/null || true
    
    show_info "Services Stopped" "\n✓ All pyMC Console services have been stopped."
}

do_restart() {
    if [ "$EUID" -ne 0 ]; then
        show_error "Service control requires root privileges.\n\nPlease run: sudo $0 restart"
        return 1
    fi
    
    echo "Restarting services..."
    systemctl restart "$BACKEND_SERVICE" 2>/dev/null || true
    sleep 2
    systemctl restart "$FRONTEND_SERVICE" 2>/dev/null || true
    sleep 1
    
    local backend_status="✗"
    local frontend_status="✗"
    backend_running && backend_status="✓"
    frontend_running && frontend_status="✓"
    
    show_info "Services Restarted" "\nBackend: $backend_status\nFrontend: $frontend_status"
}

# ============================================================================
# Uninstall Function
# ============================================================================

do_uninstall() {
    if ! is_installed; then
        show_error "pyMC Console is not installed."
        return 1
    fi
    
    if [ "$EUID" -ne 0 ]; then
        show_error "Uninstall requires root privileges.\n\nPlease run: sudo $0 uninstall"
        return 1
    fi
    
    if ! ask_yes_no "⚠️  Confirm Uninstall" "\nThis will COMPLETELY REMOVE:\n\n- pyMC Repeater service and files\n- pyMC Console frontend\n- Configuration files\n- Log files\n- Service user\n\nA backup of your config will be saved to /tmp/\n\nThis action cannot be undone!\n\nContinue?"; then
        return 0
    fi
    
    clear
    echo "=== pyMC Console Uninstall ==="
    echo ""
    
    echo "[1/6] Stopping services..."
    systemctl stop "$FRONTEND_SERVICE" 2>/dev/null || true
    systemctl stop "$BACKEND_SERVICE" 2>/dev/null || true
    systemctl disable "$FRONTEND_SERVICE" 2>/dev/null || true
    systemctl disable "$BACKEND_SERVICE" 2>/dev/null || true
    
    echo "[2/6] Backing up configuration..."
    if [ -d "$CONFIG_DIR" ]; then
        cp -r "$CONFIG_DIR" "/tmp/pymc_config_backup_$(date +%Y%m%d_%H%M%S)"
        echo "    Backup saved to /tmp/"
    fi
    
    echo "[3/6] Removing systemd services..."
    rm -f /etc/systemd/system/pymc-repeater.service
    rm -f /etc/systemd/system/pymc-frontend.service
    systemctl daemon-reload
    
    echo "[4/6] Removing installation directory..."
    rm -rf "$INSTALL_DIR"
    
    echo "[5/6] Removing configuration and logs..."
    rm -rf "$CONFIG_DIR"
    rm -rf "$LOG_DIR"
    rm -rf /var/lib/pymc_repeater
    
    echo "[6/6] Removing service user..."
    if id "$SERVICE_USER" &>/dev/null; then
        userdel "$SERVICE_USER" 2>/dev/null || true
    fi
    
    echo ""
    echo "=== Uninstall Complete ==="
    
    show_info "Uninstall Complete" "\npyMC Console has been completely removed.\n\nConfiguration backup saved to /tmp/\n\nThank you for using pyMC Console!"
}

# ============================================================================
# Helper Functions
# ============================================================================

check_spi() {
    # Skip SPI check on non-Linux systems (macOS, etc.)
    if [[ "$(uname -s)" != "Linux" ]]; then
        return 0
    fi
    
    # Check if SPI is already loaded via kernel module
    if grep -q "spi" /proc/modules 2>/dev/null; then
        return 0
    fi
    
    # Check for spidev devices (works on Ubuntu and other distros)
    if ls /dev/spidev* &>/dev/null; then
        return 0
    fi
    
    # Check if spi_bcm2835 or spi_bcm2708 modules are available (Raspberry Pi)
    if lsmod 2>/dev/null | grep -q "spi_bcm"; then
        return 0
    fi
    
    # Check if spidev module is loaded
    if lsmod 2>/dev/null | grep -q "spidev"; then
        return 0
    fi
    
    # Raspberry Pi / Ubuntu on Pi: check config.txt locations
    local config_file=""
    if [ -f "/boot/firmware/config.txt" ]; then
        # Ubuntu on Raspberry Pi uses /boot/firmware/
        config_file="/boot/firmware/config.txt"
    elif [ -f "/boot/config.txt" ]; then
        # Raspberry Pi OS uses /boot/
        config_file="/boot/config.txt"
    fi
    
    if [ -n "$config_file" ]; then
        # Raspberry Pi (any OS) - can enable via config.txt
        if grep -q "dtparam=spi=on" "$config_file" 2>/dev/null; then
            return 0
        fi
        
        if ask_yes_no "SPI Not Enabled" "\nSPI interface is required but not enabled!\n\nWould you like to enable it now?\n(This will require a reboot)"; then
            echo "dtparam=spi=on" >> "$config_file"
            show_info "SPI Enabled" "\nSPI has been enabled.\n\nSystem will reboot now.\nPlease run this script again after reboot."
            reboot
        else
            show_error "SPI is required for LoRa radio operation.\n\nPlease enable SPI manually and run this script again."
            exit 1
        fi
    else
        # Generic Linux (Ubuntu x86, other SBCs, etc.)
        # Try to load spidev module
        if modprobe spidev 2>/dev/null; then
            if ls /dev/spidev* &>/dev/null; then
                return 0
            fi
        fi
        
        # Still no SPI - warn user
        if ! ask_yes_no "SPI Check" "\nCould not verify SPI is enabled.\n\nFor LoRa radio operation, ensure SPI is enabled on your system.\n\nOn Ubuntu/Debian, you may need to:\n- Load the spidev module: sudo modprobe spidev\n- Enable SPI in device tree overlays\n- Check your hardware supports SPI\n\nContinue anyway?"; then
            exit 1
        fi
    fi
}

install_yq() {
    if ! command -v yq &> /dev/null || [[ "$(yq --version 2>&1)" != *"mikefarah/yq"* ]]; then
        echo "Installing yq..."
        install_yq_silent
    fi
}

# Silent version for use with spinner
install_yq_silent() {
    local YQ_VERSION="v4.40.5"
    local YQ_BINARY="yq_linux_arm64"
    
    if [[ "$(uname -m)" == "x86_64" ]]; then
        YQ_BINARY="yq_linux_amd64"
    elif [[ "$(uname -m)" == "armv7"* ]]; then
        YQ_BINARY="yq_linux_arm"
    elif [[ "$(uname -s)" == "Darwin" ]]; then
        YQ_BINARY="yq_darwin_arm64"
        [[ "$(uname -m)" == "x86_64" ]] && YQ_BINARY="yq_darwin_amd64"
    fi
    
    wget -qO /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/${YQ_BINARY}" && chmod +x /usr/local/bin/yq
}

create_backend_service() {
    cat > /etc/systemd/system/pymc-repeater.service << EOF
[Unit]
Description=pyMC Repeater LoRa Mesh Network Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$REPEATER_DIR
ExecStart=$INSTALL_DIR/venv/bin/python -m repeater.main
Restart=on-failure
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF
}

create_frontend_service() {
    local ip_address=$(hostname -I | awk '{print $1}')
    local node_path=$(command -v node || echo "/usr/bin/node")
    
    cat > /etc/systemd/system/pymc-frontend.service << EOF
[Unit]
Description=pyMC Console Next.js Frontend
After=network-online.target pymc-repeater.service
Wants=network-online.target pymc-repeater.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$FRONTEND_DIR
ExecStart=$node_path .next/standalone/server.js
Restart=on-failure
RestartSec=5
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOSTNAME=0.0.0.0
Environment=NEXT_PUBLIC_API_URL=http://${ip_address}:8000

[Install]
WantedBy=multi-user.target
EOF
}

install_frontend_files() {
    # Install Node.js if needed
    if ! command -v node &> /dev/null; then
        echo "Installing Node.js 20 LTS..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
    fi
    
    local npm_path=$(command -v npm || echo "/usr/bin/npm")
    local ip_address=$(hostname -I | awk '{print $1}')
    
    # Copy frontend files
    cp -r "$SCRIPT_DIR/frontend/"* "$FRONTEND_DIR/"
    
    # Create env config
    cat > "$FRONTEND_DIR/.env.local" << EOF
NEXT_PUBLIC_API_URL=http://${ip_address}:8000
EOF
    
    # Enable CORS in backend config
    if [ -f "$CONFIG_DIR/config.yaml" ]; then
        yq -i '.web.cors_enabled = true' "$CONFIG_DIR/config.yaml" 2>/dev/null || true
    fi
    
    # Install and build
    cd "$FRONTEND_DIR"
    $npm_path install --legacy-peer-deps
    rm -rf "$FRONTEND_DIR/.next" 2>/dev/null || true
    NEXT_PUBLIC_API_URL="http://${ip_address}:8000" $npm_path run build
    
    # Copy assets for standalone mode
    mkdir -p "$FRONTEND_DIR/.next/standalone/.next"
    cp -r "$FRONTEND_DIR/.next/static" "$FRONTEND_DIR/.next/standalone/.next/" 2>/dev/null || true
    cp -r "$FRONTEND_DIR/public" "$FRONTEND_DIR/.next/standalone/" 2>/dev/null || true
    
    # Create service
    create_frontend_service
    
    chown -R "$SERVICE_USER:$SERVICE_USER" "$FRONTEND_DIR"
}

# Frontend installation with progress indicators
install_frontend_files_with_progress() {
    local npm_path
    local ip_address=$(hostname -I | awk '{print $1}')
    
    # Install Node.js if needed
    if ! command -v node &> /dev/null; then
        print_info "Node.js not found, installing..."
        run_with_spinner "Adding NodeSource repository" "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -" || {
            print_error "Failed to add NodeSource repository"
            return 1
        }
        run_with_spinner "Installing Node.js" "apt-get install -y nodejs" || {
            print_error "Failed to install Node.js"
            return 1
        }
        print_success "Node.js $(node --version) installed"
    else
        print_success "Node.js $(node --version) already installed"
    fi
    
    npm_path=$(command -v npm || echo "/usr/bin/npm")
    
    # Copy frontend files
    if [ -d "$SCRIPT_DIR/frontend" ]; then
        cp -r "$SCRIPT_DIR/frontend/"* "$FRONTEND_DIR/"
        print_success "Frontend files copied"
    else
        print_error "Frontend directory not found at $SCRIPT_DIR/frontend"
        return 1
    fi
    
    # Create env config
    cat > "$FRONTEND_DIR/.env.local" << EOF
NEXT_PUBLIC_API_URL=http://${ip_address}:8000
EOF
    print_success "Environment configured (API: http://${ip_address}:8000)"
    
    # Enable CORS in backend config
    if [ -f "$CONFIG_DIR/config.yaml" ]; then
        yq -i '.web.cors_enabled = true' "$CONFIG_DIR/config.yaml" 2>/dev/null || true
        print_success "CORS enabled in backend config"
    fi
    
    # Install npm dependencies
    cd "$FRONTEND_DIR"
    
    run_with_elapsed_time "Installing npm dependencies" "$npm_path install --legacy-peer-deps" || {
        print_error "Failed to install npm dependencies"
        return 1
    }
    
    # Build frontend
    rm -rf "$FRONTEND_DIR/.next" 2>/dev/null || true
    
    run_with_elapsed_time "Building production bundle" "NEXT_PUBLIC_API_URL='http://${ip_address}:8000' $npm_path run build" || {
        print_error "Failed to build frontend"
        return 1
    }
    
    # Copy assets for standalone mode
    mkdir -p "$FRONTEND_DIR/.next/standalone/.next"
    cp -r "$FRONTEND_DIR/.next/static" "$FRONTEND_DIR/.next/standalone/.next/" 2>/dev/null || true
    cp -r "$FRONTEND_DIR/public" "$FRONTEND_DIR/.next/standalone/" 2>/dev/null || true
    print_success "Standalone assets prepared"
    
    # Create service
    create_frontend_service
    print_success "Created pymc-frontend.service"
    
    chown -R "$SERVICE_USER:$SERVICE_USER" "$FRONTEND_DIR"
    print_success "Frontend permissions set"
    
    return 0
}

rebuild_frontend() {
    local npm_path=$(command -v npm || echo "/usr/bin/npm")
    local ip_address=$(hostname -I | awk '{print $1}')
    
    # Get existing API URL or use default
    local api_url="http://${ip_address}:8000"
    if [ -f "$FRONTEND_DIR/.env.local" ]; then
        local existing_url=$(grep NEXT_PUBLIC_API_URL "$FRONTEND_DIR/.env.local" | cut -d'=' -f2)
        [ -n "$existing_url" ] && api_url="$existing_url"
    fi
    
    cd "$FRONTEND_DIR"
    $npm_path install --legacy-peer-deps
    rm -rf "$FRONTEND_DIR/.next" 2>/dev/null || true
    NEXT_PUBLIC_API_URL="$api_url" $npm_path run build
    
    # Copy assets for standalone mode
    mkdir -p "$FRONTEND_DIR/.next/standalone/.next"
    cp -r "$FRONTEND_DIR/.next/static" "$FRONTEND_DIR/.next/standalone/.next/" 2>/dev/null || true
    cp -r "$FRONTEND_DIR/public" "$FRONTEND_DIR/.next/standalone/" 2>/dev/null || true
    
    chown -R "$SERVICE_USER:$SERVICE_USER" "$FRONTEND_DIR"
}

merge_config() {
    local user_config="$1"
    local example_config="$2"
    
    if [ ! -f "$user_config" ] || [ ! -f "$example_config" ]; then
        echo "    Config merge skipped (files not found)"
        return 0
    fi
    
    if ! command -v yq &> /dev/null; then
        echo "    Config merge skipped (yq not available)"
        return 0
    fi
    
    local temp_merged="${user_config}.merged"
    
    if yq eval-all '. as $item ireduce ({}; . * $item)' "$example_config" "$user_config" > "$temp_merged" 2>/dev/null; then
        if yq eval '.' "$temp_merged" > /dev/null 2>&1; then
            mv "$temp_merged" "$user_config"
            echo "    ✓ Configuration merged (user settings preserved, new options added)"
        else
            rm -f "$temp_merged"
            echo "    ⚠ Merge validation failed, keeping original"
        fi
    else
        rm -f "$temp_merged"
        echo "    ⚠ Merge failed, keeping original"
    fi
}

# ============================================================================
# Main Menu
# ============================================================================

show_main_menu() {
    local status=$(get_status_display)
    
    CHOICE=$($DIALOG --backtitle "pyMC Console Management" --title "pyMC Console" --menu "\nStatus: $status\n\nChoose an action:" 20 70 10 \
        "install" "Install pyMC Console (fresh install)" \
        "upgrade" "Upgrade existing installation" \
        "settings" "Configure radio settings" \
        "gpio" "GPIO configuration (advanced)" \
        "start" "Start services" \
        "stop" "Stop services" \
        "restart" "Restart services" \
        "logs" "View live logs" \
        "uninstall" "Uninstall pyMC Console" \
        "exit" "Exit" 3>&1 1>&2 2>&3)
    
    case $CHOICE in
        "install") do_install ;;
        "upgrade") do_upgrade ;;
        "settings") do_settings ;;
        "gpio") do_gpio ;;
        "start") do_start ;;
        "stop") do_stop ;;
        "restart") do_restart ;;
        "logs")
            clear
            echo "=== Live Logs (Press Ctrl+C to return) ==="
            echo ""
            journalctl -u "$BACKEND_SERVICE" -u "$FRONTEND_SERVICE" -f
            ;;
        "uninstall") do_uninstall ;;
        "exit"|"") exit 0 ;;
    esac
}

# ============================================================================
# CLI Help
# ============================================================================

show_help() {
    echo "pyMC Console Management Script"
    echo ""
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  install     Install pyMC Console (fresh install)"
    echo "  upgrade     Upgrade existing installation"
    echo "  settings    Configure radio settings"
    echo "  gpio        GPIO configuration (advanced)"
    echo "  start       Start frontend and backend services"
    echo "  stop        Stop frontend and backend services"
    echo "  restart     Restart frontend and backend services"
    echo "  uninstall   Completely remove pyMC Console"
    echo ""
    echo "Run without arguments for interactive menu."
}

# ============================================================================
# Main Entry Point
# ============================================================================

# Handle CLI arguments
case "$1" in
    "--help"|"-h")
        show_help
        exit 0
        ;;
    "install")
        check_terminal
        setup_dialog
        do_install "$2"
        exit 0
        ;;
    "upgrade")
        check_terminal
        setup_dialog
        do_upgrade
        exit 0
        ;;
    "settings")
        check_terminal
        setup_dialog
        do_settings
        exit 0
        ;;
    "gpio")
        check_terminal
        setup_dialog
        do_gpio
        exit 0
        ;;
    "start")
        check_terminal
        setup_dialog
        do_start
        exit 0
        ;;
    "stop")
        check_terminal
        setup_dialog
        do_stop
        exit 0
        ;;
    "restart")
        check_terminal
        setup_dialog
        do_restart
        exit 0
        ;;
    "uninstall")
        check_terminal
        setup_dialog
        do_uninstall
        exit 0
        ;;
esac

# Interactive menu mode
check_terminal
setup_dialog

while true; do
    show_main_menu
done
