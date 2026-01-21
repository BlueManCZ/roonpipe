# RoonPipe

A Linux integration layer for [Roon](https://roonlabs.com/) that brings native desktop features like MPRIS support, media key controls, desktop notifications, and a powerful search CLI.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Linux-lightgrey.svg)

## Features

- **MPRIS Integration** — Control Roon playback using standard Linux media keys, `playerctl`, or any MPRIS-compatible application
- **Desktop Notifications** — Get notified when tracks change, complete with album artwork
- **Playback Controls** — Play, pause, stop, skip, seek, volume, shuffle, and loop
- **Track Search** — Search your entire Roon library (including TIDAL/Qobuz) via CLI or programmatically
- **GNOME Search Integration** — Search and play tracks directly from the GNOME overview or search bar
- **Unix Socket API** — Integrate with other applications using a simple JSON-based IPC protocol
- **Interactive CLI** — Search and play tracks directly from your terminal with arrow key navigation

## CLI Example

```
🎵 RoonPipe Interactive Search
==============================

🔍 Search for a track: pink floyd

Searching for "pink floyd"...

Found 50 track(s):

❯ Comfortably Numb · Pink Floyd · The Wall
  Wish You Were Here · Pink Floyd · Wish You Were Here
  Time · Pink Floyd · The Dark Side of the Moon
  Another Brick in the Wall, Pt. 2 · Pink Floyd · The Wall
  ────────────────────────────────────────
  🔍 New search
  ❌ Quit
```

## Requirements

- Linux with D-Bus (for MPRIS)
- Node.js 18+
- Roon Core on your network
- `libnotify` for desktop notifications (optional)

## Installation

### From npm (recommended)

```bash
npm install -g roonpipe
```

### From source

```bash
git clone https://github.com/BlueManCZ/roonpipe.git
cd roonpipe
pnpm install
pnpm build
pnpm start -- --install-gnome # Optional: install GNOME search provider
```

## GNOME Search Provider

To enable searching for tracks directly from the GNOME overview or search bar, install the search provider:

```bash
sudo roonpipe --install-gnome
```

This will copy the necessary files to system directories. After installation, you can search for track names in the GNOME search to see RoonPipe results.

If you see a warning when starting the daemon, run the above command to install it.

## Usage

### Running the Daemon

Start the daemon to enable MPRIS integration and the socket server:

```bash
roonpipe
```

Or if installed from source:

```bash
pnpm start
```

On first run, open Roon and authorize the "RoonPipe" extension in **Settings → Extensions**.

### Interactive CLI

Search and play tracks from your terminal:

```bash
roonpipe --cli
```

Or if installed from source:

```bash
pnpm run cli
```

Features:
- Use arrow keys to navigate search results
- Press Enter to select a track
- Choose an action: Play now, Add to queue, or Play next
- Press Ctrl+C to exit

### Development Mode

Run with hot-reload during development:

```bash
pnpm dev
```

## MPRIS Controls

Once the daemon is running, you can control Roon using standard tools:

```bash
# Basic controls
playerctl -p roon play
playerctl -p roon pause
playerctl -p roon next
playerctl -p roon previous

# Volume
playerctl -p roon volume 0.5

# Seek (in seconds)
playerctl -p roon position 30

# Get current track info
playerctl -p roon metadata
```

## Socket API

RoonPipe exposes a Unix socket at `/tmp/roonpipe.sock` for IPC communication.

### Search

```bash
echo '{"command":"search","query":"beatles"}' | nc -U /tmp/roonpipe.sock
```

Response:
```json
{
  "results": [
    {
      "title": "Let It Be",
      "subtitle": "The Beatles · Let It Be",
      "item_key": "10:0",
      "image": "/home/user/.cache/roonpipe/images/abc123.jpg",
      "sessionKey": "search_1234567890"
    }
  ]
}
```

### Play

Play a track immediately (preserves current queue):

```bash
echo '{"command":"play","item_key":"10:0","session_key":"search_1234567890","action":"playNow"}' | nc -U /tmp/roonpipe.sock
```

Add to the queue:

```bash
echo '{"command":"play","item_key":"10:0","session_key":"search_1234567890","action":"queue"}' | nc -U /tmp/roonpipe.sock
```

Play next (add after current track):

```bash
echo '{"command":"play","item_key":"10:0","session_key":"search_1234567890","action":"addNext"}' | nc -U /tmp/roonpipe.sock
```

Replace the queue and play immediately:

```bash
echo '{"command":"play","item_key":"10:0","session_key":"search_1234567890","action":"play"}' | nc -U /tmp/roonpipe.sock
```

Available actions:
- `play` (default) — Replace queue and play immediately
- `playNow` — Play immediately while preserving the queue (adds next and skips)
- `queue` — Add to the end of the queue
- `addNext` — Add after the current track

## Project Structure

```
src/
├── index.ts                 # Entry point, daemon/CLI mode switching
├── roon.ts                  # Roon API connection and browsing
├── mpris.ts                 # MPRIS player and metadata
├── notification.ts          # Desktop notifications
├── socket.ts                # Unix socket server
├── image-cache.ts           # Album artwork caching
├── gnome-search-provider.ts # GNOME search provider integration
└── cli.ts                   # Interactive terminal interface
```

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

## Acknowledgments

- [Roon Labs](https://roonlabs.com/) for the amazing music player and API
- [node-roon-api](https://github.com/roonlabs/node-roon-api) — Official Roon Node.js API
- [mpris-service](https://github.com/dbusjs/mpris-service) — MPRIS implementation for Node.js
