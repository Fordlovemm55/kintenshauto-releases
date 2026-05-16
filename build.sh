#!/bin/bash
# KINTENSHAUTO - Build Installer (Mac/Linux)

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

LOG_FILE="build-log.txt"

echo ""
echo "============================================================"
echo "  KINTENSHAUTO · 剣天照 - Build Installer"
echo "============================================================"
echo ""

# Detect OS
case "$(uname -s)" in
  Darwin*) OS="mac"; BUILD_CMD="dist:mac" ;;
  Linux*)  OS="linux"; BUILD_CMD="dist:linux" ;;
  *)       echo -e "${RED}Unsupported OS. Use build.bat on Windows.${NC}"; exit 1 ;;
esac

echo "Detected OS: $OS"
echo ""

# Check Node.js
echo "[1/5] Checking Node.js..."
if ! command -v node &> /dev/null; then
    echo -e "${RED}ERROR: Node.js not found${NC}"
    echo ""
    echo "Install Node.js 18+ from https://nodejs.org/"
    echo "Or via package manager:"
    echo "  Mac:   brew install node"
    echo "  Linux: sudo apt install nodejs npm"
    exit 1
fi

NODE_VER=$(node --version)
NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo -e "${RED}ERROR: Node.js too old ($NODE_VER). Need 18+.${NC}"
    exit 1
fi
echo -e "       ${GREEN}OK${NC}: Node.js $NODE_VER"

# Check npm
echo "[2/5] Checking npm..."
if ! command -v npm &> /dev/null; then
    echo -e "${RED}ERROR: npm not found${NC}"
    exit 1
fi
NPM_VER=$(npm --version)
echo -e "       ${GREEN}OK${NC}: npm $NPM_VER"

# OS-specific prerequisites
if [ "$OS" = "linux" ]; then
    echo "[3/5] Checking Linux build deps..."
    MISSING_PKGS=""
    for pkg in libgtk-3-dev libnss3-dev; do
        if ! dpkg -l | grep -q "$pkg"; then
            MISSING_PKGS="$MISSING_PKGS $pkg"
        fi
    done
    if [ -n "$MISSING_PKGS" ]; then
        echo -e "${YELLOW}       WARNING: missing packages:$MISSING_PKGS${NC}"
        echo "       Install with: sudo apt install$MISSING_PKGS"
        read -p "       Continue anyway? (y/N) " -n 1 -r
        echo
        [[ ! $REPLY =~ ^[Yy]$ ]] && exit 1
    else
        echo -e "       ${GREEN}OK${NC}"
    fi
elif [ "$OS" = "mac" ]; then
    echo "[3/5] Checking Xcode tools..."
    if ! xcode-select -p &> /dev/null; then
        echo -e "${YELLOW}       Xcode tools not found. Installing...${NC}"
        xcode-select --install
    fi
    echo -e "       ${GREEN}OK${NC}"
fi

# npm install
if [ -d "node_modules" ]; then
    echo "[4/5] node_modules exists - skipping install"
    echo "      (delete node_modules/ to force reinstall)"
else
    echo "[4/5] Installing dependencies (5-30 min)..."
    SKIP_POSTINSTALL=1 npm install 2>&1 | tee -a "$LOG_FILE"
    if [ ${PIPESTATUS[0]} -ne 0 ]; then
        echo -e "${RED}ERROR: npm install failed${NC}"
        echo "Check $LOG_FILE for details"
        exit 1
    fi
    echo -e "      ${GREEN}OK${NC}"

    echo "      Downloading FFmpeg, yt-dlp, fpcalc..."
    node scripts/download-deps.js 2>&1 | tee -a "$LOG_FILE" || \
        echo -e "${YELLOW}      WARNING: dep download failed - will retry on first run${NC}"
fi

# Build
echo "[5/5] Building installer (5-15 min)..."
npm run "$BUILD_CMD" 2>&1 | tee -a "$LOG_FILE"
if [ ${PIPESTATUS[0]} -ne 0 ]; then
    echo -e "${RED}ERROR: build failed${NC}"
    echo "Check $LOG_FILE"
    exit 1
fi

echo ""
echo "============================================================"
echo -e "  ${GREEN}${BOLD}BUILD SUCCESSFUL!${NC}"
echo "============================================================"
echo ""
echo "Installer file(s):"
if [ "$OS" = "mac" ]; then
    ls -lh dist-installer/*.dmg 2>/dev/null
else
    ls -lh dist-installer/*.AppImage 2>/dev/null
fi
echo ""
echo "Share the installer with others or test it yourself."
echo ""
