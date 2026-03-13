#!/usr/bin/env bash
set -euo pipefail

REPO="hdhensley/git-analyzer"
BIN_NAME="git-analytics-dashboard"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"

# Determine install directory: prefer ~/.local/bin if in PATH, else /usr/local/bin
USER_DIR="$HOME/.local/bin"
SYSTEM_DIR="/usr/local/bin"

if echo "$PATH" | tr ':' '\n' | grep -qx "$USER_DIR"; then
  INSTALL_DIR="$USER_DIR"
  USE_SUDO=""
else
  INSTALL_DIR="$SYSTEM_DIR"
  USE_SUDO="sudo"
  echo "~/.local/bin is not in PATH, installing to ${SYSTEM_DIR} (requires sudo)."
fi

echo "Fetching latest release from ${REPO}..."

# Get the AppImage download URL from the latest release
DOWNLOAD_URL=$(curl -fsSL "$API_URL" \
  | grep -oP '"browser_download_url"\s*:\s*"\K[^"]+\.AppImage(?=")' \
  | head -1)

if [ -z "$DOWNLOAD_URL" ]; then
  echo "Error: Could not find an AppImage asset in the latest release." >&2
  echo "Check https://github.com/${REPO}/releases for available downloads." >&2
  exit 1
fi

echo "Downloading $(basename "$DOWNLOAD_URL")..."

TMP_FILE=$(mktemp)
trap 'rm -f "$TMP_FILE"' EXIT

curl -fSL --progress-bar -o "$TMP_FILE" "$DOWNLOAD_URL"

$USE_SUDO mkdir -p "$INSTALL_DIR"
$USE_SUDO mv -f "$TMP_FILE" "${INSTALL_DIR}/${BIN_NAME}"
$USE_SUDO chmod +x "${INSTALL_DIR}/${BIN_NAME}"

echo ""
echo "Installed to ${INSTALL_DIR}/${BIN_NAME}"
