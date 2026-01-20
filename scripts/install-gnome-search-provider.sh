#!/bin/bash

# Install GNOME Shell Search Provider for RoonPipe

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "This script must be run as root to install system-wide."
    echo "Try: sudo $0"
    exit 1
fi

DESKTOP_FILE="com.bluemancz.RoonPipe.desktop"
SEARCH_PROVIDER_FILE="com.bluemancz.RoonPipe.SearchProvider.ini"
SERVICE_FILE="com.bluemancz.RoonPipe.SearchProvider.service"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/../data"

# Install desktop file system-wide
cp "$DATA_DIR/$DESKTOP_FILE" "/usr/share/applications/"
echo "Installed: /usr/share/applications/$DESKTOP_FILE"

# Install search provider system-wide
mkdir -p "/usr/share/gnome-shell/search-providers"
cp "$DATA_DIR/$SEARCH_PROVIDER_FILE" "/usr/share/gnome-shell/search-providers/"
echo "Installed: /usr/share/gnome-shell/search-providers/$SEARCH_PROVIDER_FILE"

# Install DBus service system-wide
mkdir -p "/usr/share/dbus-1/services"
cp "$DATA_DIR/$SERVICE_FILE" "/usr/share/dbus-1/services/"
echo "Installed: /usr/share/dbus-1/services/$SERVICE_FILE"

echo ""
echo "GNOME Shell Search Provider installed successfully!"
echo "You may need to restart GNOME Shell (Alt+F2, r) for changes to take effect."
echo ""
echo "Make sure RoonPipe daemon is running for search to work."
