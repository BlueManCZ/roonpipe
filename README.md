# RoonPipe

A Linux integration layer for [Roon](https://roonlabs.com/) that brings native desktop features like MPRIS support, media key controls, desktop notifications, and a powerful search CLI.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Linux-lightgrey.svg)

## Features

- **MPRIS Integration** — Control Roon playback using standard Linux media keys, `playerctl`, or any MPRIS-compatible application
- **Desktop Notifications** — Get notified when tracks change, complete with album artwork
- **Playback Controls** — Play, pause, stop, skip, seek, volume, shuffle, and loop
- **Library Search** — Search your entire Roon library (tracks, albums, artists, playlists, and works from local and streaming services)
- **Frequency-based Re-ranking** — Frequently played items are boosted in search results, and items missing from Roon's results are injected based on your play history
- **GNOME Search Integration** — Search and play music directly from the GNOME overview or search bar
- **Unix Socket API** — Integrate with other applications using a simple JSON-based IPC protocol
- **Interactive CLI** — Search and play music from your terminal with arrow key navigation and action menus

## CLI Example

```
🎵 RoonPipe Interactive Search
==============================

🔍 Search: pink floyd

Searching for "pink floyd"...

Found 50 result(s):

❯ 🎤 Pink Floyd
  💿 The Wall · Pink Floyd
  💿 Wish You Were Here · Pink Floyd
  🎵 Comfortably Numb · Pink Floyd
  🎵 Wish You Were Here · Pink Floyd
  🎵 Time · Pink Floyd
  ────────────────────────────────────────
  🔍 New search
  ❌ Quit

? Select an item to play: 💿 The Wall · Pink Floyd
? What do you want to do?
❯ ▶️  Play Now
  ⏭️  Add Next
  📋 Queue
  📻 Start Radio
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
- Search for tracks, albums, artists, playlists, and works
- Results grouped and ordered by type with intuitive icons (🎵 tracks, 💿 albums, 🎤 artists, 👤 composers, 📋 playlists, 🎼 works)
- Use arrow keys to navigate search results
- Press Enter to select an item
- Choose from available Roon actions (Play Now, Queue, Start Radio, etc.)
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
  "error": null,
  "results": [
    {
      "title": "The Beatles",
      "subtitle": "",
      "item_key": "100:0",
      "image": "/home/user/.cache/roonpipe/images/abc123.jpg",
      "image_key": "abc123",
      "hint": "list",
      "sessionKey": "search_1234567890",
      "type": "artist",
      "category_key": "100:1",
      "index": 0,
      "actions": [
        {"title": "Play Now"},
        {"title": "Shuffle"},
        {"title": "Queue"}
      ]
    },
    {
      "title": "Abbey Road",
      "subtitle": "The Beatles",
      "item_key": "101:0",
      "image": "/home/user/.cache/roonpipe/images/def456.jpg",
      "image_key": "def456",
      "hint": "list",
      "sessionKey": "search_1234567890",
      "type": "album",
      "category_key": "100:2",
      "index": 0,
      "actions": [
        {"title": "Play Now"},
        {"title": "Add Next"},
        {"title": "Queue"},
        {"title": "Start Radio"}
      ]
    },
    {
      "title": "Let It Be",
      "subtitle": "The Beatles",
      "item_key": "102:0",
      "image": "/home/user/.cache/roonpipe/images/ghi789.jpg",
      "image_key": "ghi789",
      "hint": "action_list",
      "sessionKey": "search_1234567890",
      "type": "track",
      "category_key": "100:3",
      "index": 0,
      "actions": [
        {"title": "Play Now"},
        {"title": "Add Next"},
        {"title": "Queue"},
        {"title": "Play Album"},
        {"title": "Start Radio"}
      ]
    }
  ]
}
```

**Search Result Fields:**
- `title` — Item title
- `subtitle` — Additional info (artist names are automatically parsed from Roon's internal format)
- `item_key` — Item identifier (ephemeral, valid only within session context)
- `image` — Local path to cached artwork, or `null`
- `image_key` — Roon image key used for artwork caching and deduplication
- `type` — Item type: `"artist"`, `"album"`, `"track"`, `"composer"`, `"playlist"`, or `"work"`
- `actions` — List of available Roon actions for this item (known actions based on type)
- `category_key` — Key to the category for navigation
- `index` — Position within the category
- `sessionKey` — Search session identifier (`"stored"` for items injected from play history)

### Play

To play an item, you need the search result fields and the action title:

```bash
echo '{"command":"play","item_key":"101:0","session_key":"search_1234567890","category_key":"100:2","item_index":0,"action_title":"Play Now"}' | nc -U /tmp/roonpipe.sock
```

Response:
```json
{
  "error": null,
  "success": true
}
```

**Play Command Parameters:**
- `item_key` — Item key from search results
- `session_key` — Session key from search results
- `category_key` — Category key from search results
- `item_index` — Index from search results
- `action_title` — Title of the action to execute (e.g., "Play Now", "Queue", "Add Next")
- `item_title` — Item title (optional, used for frequency tracking and resolving injected items)
- `item_type` — Item type (optional, used for frequency tracking)
- `item_image_key` — Image key (optional, used for frequency tracking and resolving injected items)

**How It Works:**
The play command navigates back to the item using `category_key` and `item_index` to get fresh, valid keys, then navigates through the action hierarchy to execute the action matching `action_title`. This approach works around Roon's ephemeral browse keys.

## Project Structure

```
src/
├── index.ts                 # Entry point, daemon/CLI mode switching
├── roon.ts                  # Roon API connection and browsing
├── frequency.ts             # Play frequency tracking and search re-ranking
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
