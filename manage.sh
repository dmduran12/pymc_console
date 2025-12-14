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

# Service name (backend serves both API and static frontend)
BACKEND_SERVICE="pymc-repeater"

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

# Run pip install with real progress bar
# Parses pip output to show download/install progress
run_pip_with_progress() {
    local description="$1"
    shift
    local cmd="$@"
    local log_file=$(mktemp)
    local progress_file=$(mktemp)
    local pid
    local start_time=$(date +%s)
    local width=30
    
    # Start command in background, capturing output for parsing
    eval "$cmd" 2>&1 | tee "$log_file" | while IFS= read -r line; do
        # Look for pip progress indicators
        if [[ "$line" =~ Downloading\ .*\ \(([0-9.]+)\ ([kMG]?B)\) ]]; then
            echo "Downloading..." > "$progress_file"
        elif [[ "$line" =~ Installing\ collected\ packages ]]; then
            echo "Installing..." > "$progress_file"
        elif [[ "$line" =~ Successfully\ installed ]]; then
            echo "Done" > "$progress_file"
        fi
    done &
    pid=$!
    
    # Show progress while command runs
    local phase="Starting"
    printf "        ${ARROW} %s " "$description"
    while kill -0 $pid 2>/dev/null; do
        local elapsed=$(($(date +%s) - start_time))
        local mins=$((elapsed / 60))
        local secs=$((elapsed % 60))
        
        # Read current phase if available
        [ -f "$progress_file" ] && phase=$(cat "$progress_file" 2>/dev/null || echo "$phase")
        
        # Build animated bar
        local anim_pos=$(( (elapsed * 2) % width ))
        local bar=""
        for ((i=0; i<width; i++)); do
            if [ $i -eq $anim_pos ] || [ $i -eq $((anim_pos + 1)) ]; then
                bar+="█"
            else
                bar+="░"
            fi
        done
        
        printf "\r        ${CYAN}[${bar}]${NC} %s ${DIM}(%dm %02ds)${NC}  " "$phase" $mins $secs
        sleep 0.5
    done
    
    # Get exit status
    wait $pid
    local exit_code=$?
    local elapsed=$(($(date +%s) - start_time))
    local mins=$((elapsed / 60))
    local secs=$((elapsed % 60))
    
    # Cleanup
    rm -f "$progress_file"
    
    # Clear line and show result
    printf "\r%-80s\r" " "  # Clear the line
    if [ $exit_code -eq 0 ]; then
        echo -e "        ${CHECK} $description ${DIM}(${mins}m ${secs}s)${NC}"
        rm -f "$log_file"
        return 0
    else
        echo -e "        ${CROSS} ${RED}$description${NC} ${DIM}(${mins}m ${secs}s)${NC}"
        echo -e "        ${DIM}Log output:${NC}"
        tail -20 "$log_file" | sed 's/^/        /' 
        rm -f "$log_file"
        return 1
    fi
}

# Attempt cubic-in-out easing using bash integer math (approximation)
# Returns position 0-100 given input 0-100
cubic_ease_inout() {
    local t=$1  # 0-100
    if [ $t -lt 50 ]; then
        # Ease in: 4 * t^3 (scaled)
        echo $(( (4 * t * t * t) / 10000 ))
    else
        # Ease out: 1 - (-2t + 2)^3 / 2
        local p=$((100 - t))
        echo $(( 100 - (4 * p * p * p) / 10000 ))
    fi
}

# Run npm with animated progress bar
run_npm_with_progress() {
    local description="$1"
    shift
    local cmd="$@"
    local log_file=$(mktemp)
    local pid
    local start_time=$(date +%s)
    local width=30
    local cycle_frames=60  # frames per half-cycle (smoother animation)
    
    # Start command in background
    eval "$cmd" > "$log_file" 2>&1 &
    pid=$!
    
    # Show animated progress bar while command runs
    printf "        ${ARROW} %s " "$description"
    local frame=0
    while kill -0 $pid 2>/dev/null; do
        local elapsed=$(($(date +%s) - start_time))
        local mins=$((elapsed / 60))
        local secs=$((elapsed % 60))
        
        # Calculate position in cycle (0 to cycle_frames*2)
        local cycle_pos=$(( frame % (cycle_frames * 2) ))
        local going_right=1
        [ $cycle_pos -ge $cycle_frames ] && going_right=0
        
        # Get linear position within half-cycle (0-100)
        local linear_t
        if [ $going_right -eq 1 ]; then
            linear_t=$(( (cycle_pos * 100) / cycle_frames ))
        else
            linear_t=$(( ((cycle_frames * 2 - cycle_pos) * 100) / cycle_frames ))
        fi
        
        # Apply cubic easing
        local eased_t=$(cubic_ease_inout $linear_t)
        
        # Convert to bar position
        local anim_pos=$(( (eased_t * (width - 3)) / 100 ))
        
        # Build bar
        local bar=""
        for ((j=0; j<width; j++)); do
            if [ $j -ge $anim_pos ] && [ $j -lt $((anim_pos + 3)) ]; then
                bar+="█"
            else
                bar+="░"
            fi
        done
        
        printf "\r        ${CYAN}[${bar}]${NC} %s ${DIM}(%dm %02ds)${NC}  " "$description" $mins $secs
        sleep 0.05
        ((frame++)) || true
    done
    
    # Get exit status
    wait $pid
    local exit_code=$?
    local elapsed=$(($(date +%s) - start_time))
    local mins=$((elapsed / 60))
    local secs=$((elapsed % 60))
    
    # Clear line and show result
    printf "\r%-80s\r" " "  # Clear the line
    if [ $exit_code -eq 0 ]; then
        echo -e "        ${CHECK} $description ${DIM}(${mins}m ${secs}s)${NC}"
        rm -f "$log_file"
        return 0
    else
        echo -e "        ${CROSS} ${RED}$description${NC} ${DIM}(${mins}m ${secs}s)${NC}"
        echo -e "        ${DIM}Log output:${NC}"
        tail -30 "$log_file" | sed 's/^/        /' 
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
    echo -e "  ${DIM}Installation:${NC}  $install_size"
    echo -e "  ${DIM}Configuration:${NC} $config_size"
    echo ""
    
    echo -e "${BOLD}Access your dashboard:${NC}"
    echo -e "  ${ARROW} Dashboard: ${CYAN}http://$ip_address:8000/${NC}"
    echo -e "  ${DIM}(API endpoints also available at /api/*)${NC}"
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
        local status="Stopped"
        
        backend_running && status="Running"
        
        echo "v$version | Service: $status"
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
    # Step 5: Clone pyMC_Repeater
    # =========================================================================
    print_step 5 $total_steps "Cloning pyMC_Repeater@$branch"
    
    run_npm_with_progress "Cloning repository" "git clone -b '$branch' https://github.com/rightup/pyMC_Repeater.git '$REPEATER_DIR'" || {
        print_error "Failed to clone pyMC_Repeater"
        print_info "Check if branch '$branch' exists"
        return 1
    }
    
    cd "$REPEATER_DIR"
    
    # -------------------------------------------------------------------------
    # Apply upstream patches to pyMC_Repeater (see UPSTREAM PATCHES section)
    # These will be removed once merged into pyMC_Repeater
    # -------------------------------------------------------------------------
    patch_nextjs_static_serving   # PATCH 1: Next.js static export support
    patch_api_endpoints           # PATCH 2: Radio config API endpoint
    
    # =========================================================================
    # Step 6: Install pyMC_Repeater + dependencies (including pymc_core)
    # =========================================================================
    print_step 6 $total_steps "Installing pyMC_Repeater + pymc_core (via pip)"
    
    # Match upstream: let pip resolve ALL dependencies from pyproject.toml
    # This installs pymc_core[hardware] automatically as a dependency
    run_npm_with_progress "Installing Python packages" "pip install --force-reinstall --no-cache-dir ." || {
        print_error "Failed to install pyMC_Repeater package"
        print_info "Branch '$branch' must exist in both pymc_core and pyMC_Repeater repos"
        return 1
    }
    
    # -------------------------------------------------------------------------
    # Apply pymc_core patch (AFTER pip install since it patches installed pkg)
    # -------------------------------------------------------------------------
    patch_pymc_core_gpio          # PATCH 3: Fix GPIO initialization bug
    
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
    # Step 9: Install static frontend
    # =========================================================================
    print_step 9 $total_steps "Installing static frontend"
    
    install_static_frontend || {
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
    
    print_info "Enabling service..."
    systemctl daemon-reload
    systemctl enable "$BACKEND_SERVICE" >/dev/null 2>&1
    print_success "Service enabled"
    
    print_info "Starting backend service..."
    if systemctl start "$BACKEND_SERVICE"; then
        sleep 2
        if backend_running; then
            print_success "Backend service running (serves API + frontend)"
        else
            print_warning "Backend service started but may not be healthy"
        fi
    else
        print_warning "Backend service failed to start (configure radio settings first)"
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
    
    # Get current branch or default to dev
    cd "$REPEATER_DIR" 2>/dev/null || true
    local current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "dev")
    
    # Branch selection
    local branch="${1:-}"
    if [ -z "$branch" ]; then
        branch=$($DIALOG --backtitle "pyMC Console Management" --title "Select Branch" --menu "\nCurrent branch: $current_branch\n\nSelect the branch to upgrade to:" 16 60 4 \
            "dev" "Development branch (recommended)" \
            "main" "Stable release" \
            "keep" "Keep current branch ($current_branch)" \
            "custom" "Enter custom branch name" 3>&1 1>&2 2>&3)
        
        if [ -z "$branch" ]; then
            return 0  # User cancelled
        fi
        
        if [ "$branch" = "keep" ]; then
            branch="$current_branch"
        elif [ "$branch" = "custom" ]; then
            branch=$(get_input "Custom Branch" "Enter the branch name:" "$current_branch")
            if [ -z "$branch" ]; then
                return 0
            fi
        fi
    fi
    
    if ! ask_yes_no "Confirm Upgrade" "Current version: $current_version\nTarget branch: $branch\n\nThis will:\n- Update pyMC_Repeater to $branch\n- Update frontend dashboard\n- Preserve your configuration\n\nContinue?"; then
        return 0
    fi
    
    # Print banner
    print_banner
    echo -e "  ${DIM}Upgrading to branch: $branch${NC}"
    echo -e "  ${DIM}Current version: $current_version${NC}"
    
    local total_steps=6
    
    # =========================================================================
    # Step 1: Stop service
    # =========================================================================
    print_step 1 $total_steps "Stopping service"
    systemctl stop "$BACKEND_SERVICE" 2>/dev/null || true
    print_success "Service stopped"
    
    # =========================================================================
    # Step 2: Backup configuration
    # =========================================================================
    print_step 2 $total_steps "Backing up configuration"
    local backup_file="$CONFIG_DIR/config.yaml.backup.$(date +%Y%m%d_%H%M%S)"
    cp "$CONFIG_DIR/config.yaml" "$backup_file"
    print_success "Backup saved to: $backup_file"
    
    # =========================================================================
    # Step 3: Update pyMC_Repeater
    # =========================================================================
    print_step 3 $total_steps "Updating pyMC_Repeater@$branch"
    cd "$REPEATER_DIR"
    
    run_with_spinner "Fetching updates" "git fetch origin" || {
        print_error "Failed to fetch updates"
        return 1
    }
    
    git checkout "$branch" 2>/dev/null || git checkout -b "$branch" "origin/$branch" 2>/dev/null
    
    run_with_spinner "Pulling latest changes" "git pull origin $branch" || {
        print_error "Failed to pull branch $branch"
        return 1
    }
    print_success "Repository updated"
    
    # =========================================================================
    # Step 4: Update Python packages
    # =========================================================================
    print_step 4 $total_steps "Updating Python packages"
    source "$INSTALL_DIR/venv/bin/activate"
    
    # -------------------------------------------------------------------------
    # Apply upstream patches to pyMC_Repeater (see UPSTREAM PATCHES section)
    # These will be removed once merged into pyMC_Repeater
    # -------------------------------------------------------------------------
    patch_nextjs_static_serving   # PATCH 1: Next.js static export support
    patch_api_endpoints           # PATCH 2: Radio config API endpoint
    
    # Match upstream: let pip resolve ALL dependencies from pyproject.toml
    # This installs/updates pymc_core[hardware] automatically as a dependency
    run_npm_with_progress "Installing pyMC_Repeater + dependencies" "pip install --force-reinstall --no-cache-dir ." || {
        print_error "Failed to install pyMC_Repeater"
        print_info "Branch '$branch' must exist in both pymc_core and pyMC_Repeater repos"
        return 1
    }
    
    # -------------------------------------------------------------------------
    # Apply pymc_core patch (AFTER pip install since it patches installed pkg)
    # -------------------------------------------------------------------------
    patch_pymc_core_gpio          # PATCH 3: Fix GPIO initialization bug
    
    # =========================================================================
    # Step 5: Update configuration & frontend
    # =========================================================================
    print_step 5 $total_steps "Updating configuration & frontend"
    
    merge_config "$CONFIG_DIR/config.yaml" "$REPEATER_DIR/config.yaml.example"
    print_success "Configuration merged"
    
    # Update static frontend files
    if [ -d "$SCRIPT_DIR/frontend/out" ]; then
        local target_dir="$REPEATER_DIR/repeater/web/html"
        rm -rf "$target_dir" 2>/dev/null || true
        mkdir -p "$target_dir"
        cp -r "$SCRIPT_DIR/frontend/out/"* "$target_dir/"
        chown -R "$SERVICE_USER:$SERVICE_USER" "$target_dir"
        print_success "Dashboard updated"
    else
        print_warning "Frontend build not found - dashboard not updated"
    fi
    
    create_backend_service
    systemctl daemon-reload
    print_success "Service configuration updated"
    
    # =========================================================================
    # Step 6: Start service
    # =========================================================================
    print_step 6 $total_steps "Starting service"
    
    if systemctl start "$BACKEND_SERVICE"; then
        sleep 2
        if backend_running; then
            print_success "Service running"
        else
            print_warning "Service started but may not be healthy"
        fi
    else
        print_warning "Service failed to start"
    fi
    
    # Show completion
    local new_version=$(get_version)
    local ip_address=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
    
    echo ""
    echo -e "${BOLD}${GREEN}════════════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}${GREEN}  Upgrade Complete!${NC}"
    echo -e "${BOLD}${GREEN}════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${CHECK} Version: ${DIM}$current_version${NC} → ${BOLD}$new_version${NC}"
    echo -e "  ${CHECK} Branch: ${BOLD}$branch${NC}"
    echo -e "  ${CHECK} Configuration preserved"
    echo -e "  ${CHECK} Dashboard: ${CYAN}http://$ip_address:8000${NC}"
    echo ""
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
    
    # Fetch presets from API or local files
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
                ((preset_count++)) || true
                preset_titles+=("$title")
                preset_freqs+=("$freq")
                preset_sfs+=("$sf")
                preset_bws+=("$bw")
                preset_crs+=("$cr")
                echo -e "  ${CYAN}$preset_count)${NC} $title ${DIM}(${freq}MHz SF$sf BW${bw}kHz)${NC}"
            fi
        done < <(echo "$presets_json" | jq -c '.[]' 2>/dev/null)
    fi
    
    # If no presets loaded, show fallback options with descriptions
    if [ $preset_count -eq 0 ]; then
        echo -e "  ${YELLOW}Could not fetch presets from API. Showing common options:${NC}"
        echo ""
        # Fallback presets with common MeshCore configurations
        preset_titles=("MeshCore USA" "MeshCore EU" "MeshCore UK" "MeshCore AU/NZ" "Long Range USA" "Long Range EU")
        preset_freqs=("906.875" "869.525" "869.525" "917.0" "903.9" "869.4")
        preset_sfs=("11" "11" "11" "11" "12" "12")
        preset_bws=("250" "250" "250" "250" "125" "125")
        preset_crs=("5" "5" "5" "5" "8" "8")
        preset_count=${#preset_titles[@]}
        
        echo -e "  ${CYAN}1)${NC} MeshCore USA      ${DIM}(906.875MHz SF11 BW250kHz - Americas default)${NC}"
        echo -e "  ${CYAN}2)${NC} MeshCore EU       ${DIM}(869.525MHz SF11 BW250kHz - Europe default)${NC}"
        echo -e "  ${CYAN}3)${NC} MeshCore UK       ${DIM}(869.525MHz SF11 BW250kHz - UK ISM band)${NC}"
        echo -e "  ${CYAN}4)${NC} MeshCore AU/NZ    ${DIM}(917.0MHz SF11 BW250kHz - Australia/NZ)${NC}"
        echo -e "  ${CYAN}5)${NC} Long Range USA    ${DIM}(903.9MHz SF12 BW125kHz - Max range, slower)${NC}"
        echo -e "  ${CYAN}6)${NC} Long Range EU     ${DIM}(869.4MHz SF12 BW125kHz - Max range, slower)${NC}"
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
        
        # Apply custom settings
        local freq_hz=$(awk "BEGIN {printf \"%.0f\", $freq_mhz * 1000000}")
        local bw_hz=$(awk "BEGIN {printf \"%.0f\", $bw_khz * 1000}")
        
        yq -i ".radio.frequency = $freq_hz" "$config_file"
        yq -i ".radio.spreading_factor = $sf" "$config_file"
        yq -i ".radio.bandwidth = $bw_hz" "$config_file"
        yq -i ".radio.coding_rate = $cr" "$config_file"
        
        echo ""
        print_success "Radio: ${freq_mhz}MHz SF$sf BW${bw_khz}kHz CR$cr"
    elif [[ "$preset_choice" =~ ^[0-9]+$ ]] && [ "$preset_choice" -ge 1 ] && [ "$preset_choice" -le "$preset_count" ]; then
        # Use preset
        local idx=$((preset_choice - 1))
        freq_mhz="${preset_freqs[$idx]}"
        sf="${preset_sfs[$idx]}"
        bw_khz="${preset_bws[$idx]}"
        cr="${preset_crs[$idx]}"
        print_success "Using preset: ${preset_titles[$idx]}"
        
        # Apply settings
        local freq_hz=$(awk "BEGIN {printf \"%.0f\", $freq_mhz * 1000000}")
        local bw_hz=$(awk "BEGIN {printf \"%.0f\", $bw_khz * 1000}")
        
        yq -i ".radio.frequency = $freq_hz" "$config_file"
        yq -i ".radio.spreading_factor = $sf" "$config_file"
        yq -i ".radio.bandwidth = $bw_hz" "$config_file"
        yq -i ".radio.coding_rate = $cr" "$config_file"
        
        echo ""
        print_success "Radio: ${freq_mhz}MHz SF$sf BW${bw_khz}kHz CR$cr"
    else
        print_warning "Invalid selection, keeping current radio settings"
    fi
    
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
            ((hw_count++)) || true
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
        ((index++)) || true
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
    
    # Use keys_unsorted to preserve JSON insertion order (matches upstream grep-based parsing)
    while IFS= read -r key; do
        local name=$(jq -r ".hardware.\"$key\".name" "$hw_config")
        menu_items+=("$key" "$name")
    done < <(jq -r '.hardware | keys_unsorted[]' "$hw_config" 2>/dev/null)
    
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
    
    echo "Starting service..."
    systemctl start "$BACKEND_SERVICE" 2>/dev/null || true
    sleep 2
    
    local status="✗"
    backend_running && status="✓"
    
    show_info "Service Started" "\npyMC Repeater: $status\n\nDashboard: http://$(hostname -I | awk '{print $1}'):8000/"
}

do_stop() {
    if [ "$EUID" -ne 0 ]; then
        show_error "Service control requires root privileges.\n\nPlease run: sudo $0 stop"
        return 1
    fi
    
    echo "Stopping service..."
    systemctl stop "$BACKEND_SERVICE" 2>/dev/null || true
    
    show_info "Service Stopped" "\n✓ pyMC Repeater service has been stopped."
}

do_restart() {
    if [ "$EUID" -ne 0 ]; then
        show_error "Service control requires root privileges.\n\nPlease run: sudo $0 restart"
        return 1
    fi
    
    echo "Restarting service..."
    systemctl restart "$BACKEND_SERVICE" 2>/dev/null || true
    sleep 2
    
    local status="✗"
    backend_running && status="✓"
    
    show_info "Service Restarted" "\npyMC Repeater: $status\n\nDashboard: http://$(hostname -I | awk '{print $1}'):8000/"
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
    
    if ! ask_yes_no "⚠️  Confirm Uninstall" "\nThis will COMPLETELY REMOVE:\n\n- pyMC Repeater service and files\n- pyMC Console frontend\n- Configuration files\n- Log files\n- Service user\n\nThis action cannot be undone!\n\nContinue?"; then
        return 0
    fi
    
    clear
    echo "=== pyMC Console Uninstall ==="
    echo ""
    
    echo "[1/6] Stopping service..."
    systemctl stop "$BACKEND_SERVICE" 2>/dev/null || true
    systemctl disable "$BACKEND_SERVICE" 2>/dev/null || true
    
    echo "[2/6] Backing up configuration..."
    local backup_path=""
    if [ -d "$CONFIG_DIR" ]; then
        backup_path="/tmp/pymc_config_backup_$(date +%Y%m%d_%H%M%S)"
        cp -r "$CONFIG_DIR" "$backup_path"
        echo "    Backup saved to: $backup_path"
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
    echo ""
    
    # Offer to delete backup
    if [ -n "$backup_path" ] && [ -d "$backup_path" ]; then
        if ask_yes_no "Delete Backup?" "\nA backup of your configuration was saved to:\n$backup_path\n\nWould you like to delete this backup?\n\n(Choose 'No' to keep it for future reference)"; then
            rm -rf "$backup_path"
            show_info "Uninstall Complete" "\npyMC Console has been completely removed.\n\nBackup deleted.\n\nThank you for using pyMC Console!"
        else
            show_info "Uninstall Complete" "\npyMC Console has been completely removed.\n\nConfiguration backup saved to:\n$backup_path\n\nThank you for using pyMC Console!"
        fi
    else
        show_info "Uninstall Complete" "\npyMC Console has been completely removed.\n\nThank you for using pyMC Console!"
    fi
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

# ============================================================================
# UPSTREAM PATCHES
# ============================================================================
# These patches modify pyMC_Repeater to support pymc_console features.
# They are applied during install/upgrade and should be converted to a
# clean PR for https://github.com/rightup/pyMC_Repeater once stable.
#
# PATCH REGISTRY:
# ---------------
# 1. patch_nextjs_static_serving (http_server.py)
#    - Adds route-specific index.html serving for Next.js static export
#    - Adds /_next and /images static directory routes
#    - PR Status: Pending
#
# 2. patch_api_endpoints (api_endpoints.py)
#    - Adds POST /api/update_radio_config endpoint
#    - Allows web UI to update radio settings and save to config.yaml
#    - PR Status: Pending
#
# 3. patch_pymc_core_gpio (pymc_core SX126x.py)
#    - CRITICAL: Fixes GPIO initialization bug in dev branch
#    - Bug: _get_output() sets initial_value=True (HIGH) for all pins
#    - Impact: Both TXEN and RXEN are HIGH, breaking RX on E22 modules
#    - Fix: Change initial_value to False (LOW) - matches gpiozero default
#    - PR Status: Pending - should be filed against rightup/pyMC_core
#
# To generate clean patches for upstream PR:
#   1. Clone fresh pyMC_Repeater
#   2. Apply patches via manage.sh upgrade
#   3. git diff > patches/feature-name.patch
# ============================================================================

# ------------------------------------------------------------------------------
# PATCH 1: Next.js Static Export Support
# ------------------------------------------------------------------------------
# File: repeater/web/http_server.py
# Purpose: Enable serving Next.js static export instead of Vue.js SPA
# Changes:
#   - default() method: Serve route-specific index.html (e.g., /packets/ -> packets/index.html)
#   - Add /_next static directory for Next.js chunks/assets
#   - Add /images static directory for background images
#   - Update CORS config for new routes
# ------------------------------------------------------------------------------
patch_nextjs_static_serving() {
    local http_server="$REPEATER_DIR/repeater/web/http_server.py"
    
    if [ ! -f "$http_server" ]; then
        print_warning "http_server.py not found, skipping patch"
        return 0
    fi
    
    # Check if already patched (look for route_path which is unique to our patch)
    if grep -q 'route_path = os.path.join' "$http_server" 2>/dev/null; then
        print_info "Next.js static serving already configured"
        return 0
    fi
    
    # Use Python to apply the patch reliably (sed is fragile for multi-line changes)
    python3 << PATCHEOF
import re
import os

http_server_path = "$http_server"

with open(http_server_path, 'r') as f:
    content = f.read()

# 1. Patch the default() method to serve route-specific index.html files
# Match the default method and replace just the body after the API check
old_pattern = r'''(    @cherrypy\.expose
    def default\(self, \*args, \*\*kwargs\):.*?# Let API routes pass through
        if args and args\[0\] == 'api':
            raise cherrypy\.NotFound\(\)
        
        # For )(all other routes, serve the Vue\.js app \(client-side routing\)|any other route, serve index\.html \(Vue router handles it\))(
        return self\.index\(\))'''

new_body = r'''\1Next.js static export, try to serve the specific route's index.html
        # e.g., /packets/ -> html/packets/index.html
        if args:
            # Build path to route-specific index.html
            route_path = os.path.join(self.html_dir, *args, "index.html")
            if os.path.isfile(route_path):
                try:
                    with open(route_path, 'r', encoding='utf-8') as f:
                        return f.read()
                except Exception as e:
                    logger.error(f"Error serving {route_path}: {e}")
        
        # Fallback to root index.html for SPA routing
        return self.index()'''

content = re.sub(old_pattern, new_body, content, flags=re.DOTALL)

# Update docstring
content = content.replace(
    'Handle client-side routing - serve index.html for all non-API routes.',
    'Handle routing for static export - serve the correct index.html for each route.'
)

# 2. Add next_dir and images_dir after assets_dir
if 'next_dir = os.path.join' not in content:
    content = content.replace(
        'assets_dir = os.path.join(html_dir, "assets")',
        '''assets_dir = os.path.join(html_dir, "assets")
            next_dir = os.path.join(html_dir, "_next")  # Next.js static assets
            images_dir = os.path.join(html_dir, "images")  # Images directory'''
    )

# 3. Add /_next and /images route configs before /favicon.ico
if '"/_next":' not in content:
    next_config = '''# Next.js static assets (CSS, JS, fonts, etc.)
                "/_next": {
                    "tools.staticdir.on": True,
                    "tools.staticdir.dir": next_dir,
                    "tools.staticdir.content_types": {
                        'js': 'application/javascript',
                        'css': 'text/css',
                        'map': 'application/json',
                        'woff2': 'font/woff2',
                        'woff': 'font/woff',
                        'ttf': 'font/ttf',
                    },
                },
                # Images directory
                "/images": {
                    "tools.staticdir.on": True,
                    "tools.staticdir.dir": images_dir,
                },
                "/favicon.ico": {'''
    content = content.replace('"/favicon.ico": {', next_config)

# 4. Add CORS for new routes
if 'config["/_next"]' not in content and 'config["/favicon.ico"]["cors.expose.on"]' in content:
    content = content.replace(
        'config["/favicon.ico"]["cors.expose.on"] = True',
        '''config["/_next"]["cors.expose.on"] = True
                config["/images"]["cors.expose.on"] = True
                config["/favicon.ico"]["cors.expose.on"] = True'''
    )

# Update comment from Vue.js to frontend
content = content.replace(
    '# Serve static files from the html directory (compiled Vue.js app)',
    '# Serve static files from the html directory (compiled frontend app)'
)

with open(http_server_path, 'w') as f:
    f.write(content)
PATCHEOF
    
    # Verify patch was applied
    if grep -q 'route_path = os.path.join' "$http_server" 2>/dev/null; then
        print_success "Patched http_server.py for Next.js static serving"
    else
        print_warning "Patch may not have applied correctly"
    fi
}

# ------------------------------------------------------------------------------
# PATCH 2: Radio Configuration API Endpoint
# ------------------------------------------------------------------------------
# File: repeater/web/api_endpoints.py
# Purpose: Allow web UI to update radio settings without SSH/CLI
# Changes:
#   - Add POST /api/update_radio_config endpoint
#   - Accepts: frequency_mhz, bandwidth_khz, spreading_factor, coding_rate, tx_power
#   - Validates input ranges (SF 5-12, CR 5-8, power 2-22 dBm)
#   - Saves to config.yaml via existing _save_config_to_file()
#   - Returns restart_required: true (live radio update not yet supported)
# ------------------------------------------------------------------------------
patch_api_endpoints() {
    local api_file="$REPEATER_DIR/repeater/web/api_endpoints.py"
    
    if [ ! -f "$api_file" ]; then
        print_warning "api_endpoints.py not found, skipping patch"
        return 0
    fi
    
    # Check if already patched
    if grep -q 'def update_radio_config' "$api_file" 2>/dev/null; then
        print_info "API endpoints already patched"
        return 0
    fi
    
    # Use Python to add the endpoint (note: no quotes around PATCHEOF to allow variable expansion)
    python3 << PATCHEOF
import re

api_file = "$api_file"

with open(api_file, 'r') as f:
    content = f.read()

# Add update_radio_config endpoint after save_cad_settings
update_radio_config_code = '''

    @cherrypy.expose
    @cherrypy.tools.json_out()
    @cherrypy.tools.json_in()
    def update_radio_config(self):
        """Update radio configuration and save to config.yaml
        
        POST /api/update_radio_config
        Body: {
            "frequency_mhz": 906.875,
            "bandwidth_khz": 250,
            "spreading_factor": 10,
            "coding_rate": 5,
            "tx_power": 22
        }
        
        Returns: {"success": true, "data": {"applied": [...], "persisted": true, "restart_required": true}}
        """
        try:
            self._require_post()
            data = cherrypy.request.json or {}
            
            if not data:
                return self._error("No configuration provided")
            
            applied = []
            
            # Ensure radio config section exists
            if "radio" not in self.config:
                self.config["radio"] = {}
            
            # Update frequency (convert MHz to Hz for storage)
            if "frequency_mhz" in data:
                freq_hz = int(float(data["frequency_mhz"]) * 1_000_000)
                self.config["radio"]["frequency"] = freq_hz
                applied.append(f"frequency={data['frequency_mhz']}MHz")
            
            # Update bandwidth (convert kHz to Hz for storage)
            if "bandwidth_khz" in data:
                bw_hz = int(float(data["bandwidth_khz"]) * 1000)
                self.config["radio"]["bandwidth"] = bw_hz
                applied.append(f"bandwidth={data['bandwidth_khz']}kHz")
            
            # Update spreading factor
            if "spreading_factor" in data:
                sf = int(data["spreading_factor"])
                if sf < 5 or sf > 12:
                    return self._error("Spreading factor must be 5-12")
                self.config["radio"]["spreading_factor"] = sf
                applied.append(f"SF={sf}")
            
            # Update coding rate
            if "coding_rate" in data:
                cr = int(data["coding_rate"])
                if cr < 5 or cr > 8:
                    return self._error("Coding rate must be 5-8 (4/5 to 4/8)")
                self.config["radio"]["coding_rate"] = cr
                applied.append(f"CR=4/{cr}")
            
            # Update TX power
            if "tx_power" in data:
                power = int(data["tx_power"])
                if power < 2 or power > 22:
                    return self._error("TX power must be 2-22 dBm")
                self.config["radio"]["tx_power"] = power
                applied.append(f"power={power}dBm")
            
            if not applied:
                return self._error("No valid settings provided")
            
            # Save to config file
            config_path = getattr(self, '_config_path', '/etc/pymc_repeater/config.yaml')
            self._save_config_to_file(config_path)
            
            logger.info(f"Radio config updated: {', '.join(applied)}")
            
            return self._success({
                "applied": applied,
                "persisted": True,
                "live_update": False,
                "restart_required": True,
                "message": "Settings saved. Restart service to apply changes."
            })
            
        except cherrypy.HTTPError:
            raise
        except Exception as e:
            logger.error(f"Error updating radio config: {e}")
            return self._error(str(e))
'''

# Find the save_cad_settings method and insert after it
# Look for the end of save_cad_settings (the except block)
pattern = r'(    def save_cad_settings\(self\):.*?return self\._error\(e\))'
match = re.search(pattern, content, re.DOTALL)

if match:
    insert_pos = match.end()
    content = content[:insert_pos] + update_radio_config_code + content[insert_pos:]
    
    with open(api_file, 'w') as f:
        f.write(content)
    print("Patched api_endpoints.py with update_radio_config")
else:
    print("Could not find insertion point for update_radio_config")
PATCHEOF
    
    # Verify patch was applied
    if grep -q 'def update_radio_config' "$api_file" 2>/dev/null; then
        print_success "Patched api_endpoints.py with update_radio_config"
    else
        print_warning "API patch may not have applied correctly"
    fi
}

# ------------------------------------------------------------------------------
# PATCH 3: pymc_core GPIO Initialization Bug Fix
# ------------------------------------------------------------------------------
# File: pymc_core/hardware/lora/LoRaRF/SX126x.py (installed via pip)
# Purpose: Fix GPIO pin initialization that breaks RX on E22 modules
# 
# Root Cause Analysis:
#   The dev branch refactored GPIO management to use a centralized GPIOPinManager.
#   In _get_output() and _try_get_output(), pins are created with initial_value=True.
#   This sets ALL output pins HIGH on first access, including TXEN.
#   
#   For E22 modules with external PA/LNA:
#     - RX mode requires: TXEN=LOW, RXEN=HIGH
#     - TX mode requires: TXEN=HIGH, RXEN=LOW
#   
#   With initial_value=True, both TXEN and RXEN end up HIGH, which:
#     - Puts the RF switch in an undefined state
#     - TX works (TXEN=HIGH is correct for TX)
#     - RX fails (TXEN should be LOW during RX)
#
# Observable Symptoms:
#   - GPIO12 (RXEN) = HIGH, GPIO13 (TXEN) = HIGH (both HIGH = broken)
#   - Noise floor shows reasonable value (~-116 dBm)
#   - TX packets transmit successfully
#   - RX count stays at 0 despite mesh traffic
#   - Main branch works (shows GPIO12=LOW, GPIO13=HIGH)
#
# Fix:
#   Change initial_value=True to initial_value=False in _get_output() and
#   _try_get_output(). This matches gpiozero's DigitalOutputDevice default.
# ------------------------------------------------------------------------------
patch_pymc_core_gpio() {
    # Find the installed SX126x.py in the virtual environment
    local sx126x_file="$INSTALL_DIR/venv/lib/python*/site-packages/pymc_core/hardware/lora/LoRaRF/SX126x.py"
    sx126x_file=$(ls $sx126x_file 2>/dev/null | head -1)
    
    if [ -z "$sx126x_file" ] || [ ! -f "$sx126x_file" ]; then
        # Try dist-packages (system install)
        sx126x_file=$(find /usr/local/lib -name "SX126x.py" -path "*/pymc_core/*" 2>/dev/null | head -1)
    fi
    
    if [ -z "$sx126x_file" ] || [ ! -f "$sx126x_file" ]; then
        print_warning "SX126x.py not found, skipping GPIO patch"
        return 0
    fi
    
    # Check if this is the dev branch version (has gpio_manager code)
    if ! grep -q '_gpio_manager.setup_output_pin' "$sx126x_file" 2>/dev/null; then
        print_info "SX126x.py doesn't need GPIO patch (main branch or already patched)"
        return 0
    fi
    
    # Check if already patched (initial_value=False)
    if grep -q 'initial_value=False' "$sx126x_file" 2>/dev/null; then
        print_info "GPIO initialization already patched"
        return 0
    fi
    
    # Apply the fix: change initial_value=True to initial_value=False
    # This affects _get_output() and _try_get_output() functions
    sed -i 's/_gpio_manager.setup_output_pin(pin, initial_value=True)/_gpio_manager.setup_output_pin(pin, initial_value=False)/g' "$sx126x_file"
    
    # Verify patch was applied
    if grep -q 'initial_value=False' "$sx126x_file" 2>/dev/null; then
        print_success "Patched SX126x.py GPIO initialization (initial_value=False)"
    else
        print_warning "GPIO patch may not have applied correctly"
    fi
}

create_backend_service() {
    cat > /etc/systemd/system/pymc-repeater.service << EOF
[Unit]
Description=pyMC Repeater Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$REPEATER_DIR
Environment="PYTHONPATH=$REPEATER_DIR"
Environment="PYTHONUNBUFFERED=1"

# Start command - use python module directly with proper path
ExecStart=$INSTALL_DIR/venv/bin/python -m repeater.main --config $CONFIG_DIR/config.yaml

# Restart on failure
Restart=on-failure
RestartSec=5

# Resource limits
MemoryLimit=256M

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pymc-repeater

# Security (relaxed for proper operation)
NoNewPrivileges=true
ReadWritePaths=$LOG_DIR /var/lib/pymc_repeater $CONFIG_DIR

[Install]
WantedBy=multi-user.target
EOF
}

# Install pre-built static frontend files
# Replaces pyMC_Repeater's built-in Vue dashboard with our Next.js dashboard
# Backend's CherryPy server serves static files from repeater/web/html/
install_static_frontend() {
    local static_src="$SCRIPT_DIR/frontend/out"
    local target_dir="$REPEATER_DIR/repeater/web/html"
    
    # Check if pre-built static files exist
    if [ ! -d "$static_src" ]; then
        print_error "Static frontend files not found at $static_src"
        print_info "Build the frontend first: cd frontend && npm run build"
        return 1
    fi
    
    # Backup existing Vue dashboard if present
    if [ -d "$target_dir" ]; then
        local backup_dir="${target_dir}.vue-backup"
        if [ ! -d "$backup_dir" ]; then
            mv "$target_dir" "$backup_dir"
            print_info "Backed up original Vue dashboard to ${backup_dir##*/}"
        else
            rm -rf "$target_dir"
        fi
    fi
    
    # Copy our Next.js static build to backend's html directory
    mkdir -p "$target_dir"
    cp -r "$static_src/"* "$target_dir/"
    print_success "Dashboard installed ($(du -sh "$target_dir" | cut -f1))"
    
    # Set permissions
    chown -R "$SERVICE_USER:$SERVICE_USER" "$target_dir"
    print_success "Permissions set"
    
    print_info "Dashboard will be served at http://<ip>:8000/"
    
    return 0
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
            journalctl -u "$BACKEND_SERVICE" -f
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
    echo "  start       Start pyMC Repeater service"
    echo "  stop        Stop pyMC Repeater service"
    echo "  restart     Restart pyMC Repeater service"
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
