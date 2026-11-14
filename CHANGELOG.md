# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.15] - 2026-11-14

### Fixed

- The daemon no longer crashes when the connection to the Roon Core drops (Core restart,
  resume from suspend). Tearing down the queue subscription on an already-closed connection
  raised an uncaught error inside the Roon API library; the daemon now skips that request
  and reconnects as intended.
- The pairing watchdog no longer keeps warning after a successful reconnect to the same Core.

## [1.0.14] - 2026-07-31

### Added

- Network (TCP) API exposing the same command protocol as the Unix socket, guarded by a
  mandatory `ROONPIPE_TOKEN` shared secret.
- `now_playing` snapshot command.
- Tidal URL handling (`tidal://track/...`).
- `queue` command to read the active zone's play queue, and `play_from_queue` to start
  playback from a queue item.
- Pairing state is now reported explicitly. A watchdog explains an unpaired daemon on the
  console, distinguishing "no Roon Core found on the network" from "Core found, but the
  extension has not been enabled in Roon → Settings → Extensions".
- New `status` socket command returning the pairing state, discovered Core hosts and a
  human-readable explanation.

### Changed

- The Unix socket and network API listeners now start before Roon pairing instead of after.
  Commands that need a Core are rejected with an actionable reason rather than the daemon
  being unreachable, so `--cli` can explain an unauthorized extension.
- `--cli` checks daemon readiness before prompting and reports why it cannot search.

### Fixed

- A second daemon could be started while the first was waiting for authorization, because
  instance detection probed a socket that did not exist until pairing.
- The socket listener was torn down and rebuilt on every Core reconnection; it now binds once.
- `--cli` no longer reports "No results found" when the search request itself failed.

## [1.0.13] - 2026-03-26

### Fixed

- Notification de-duplication now includes the track title in the notification ID.

## [1.0.12] - 2026-03-13

### Changed

- Improved Core reconnection handling and zone detection logic.

## [1.0.11] - 2026-03-07

### Changed

- Improved artist image handling.
- Playback title prioritization corrected.

### Fixed

- "No Results" items returned by Roon are now skipped.

## [1.0.10] - 2026-03-06

### Added

- "Remove from History" action.

### Changed

- Refined album resolution logic.

## [1.0.9] - 2026-03-04

### Added

- Playback frequency tracking, with search results re-ranked based on usage.
- "Play Album" action for tracks.

## [1.0.8] - 2026-02-13

### Fixed

- Resuming playback from a paused state is now detected via seek updates when Roon does not
  send `zones_changed`.

## [1.0.7] - 2026-02-13

### Changed

- MPRIS metadata updates are more responsive; artwork caching is handled separately.
- Old image cache is cleared at startup.

## [1.0.6] - 2026-02-06

### Changed

- Improved MPRIS playback state updates and refined notification logic.

## [1.0.5] - 2026-01-23

### Added

- Playback support for artists, albums and playlists, not just tracks.
- `--install-gnome` option to install the GNOME Shell search provider.

### Changed

- GNOME Shell search results limited to 5.
- Notifications use a replace ID so they update in place.

## [1.0.4] - 2026-01-20

### Added

- GNOME Shell search provider integration.

### Changed

- Desktop notifications reworked.

## [1.0.3] - 2026-01-19

### Changed

- TypeScript compilation and minification moved to SWC.
- Improved playback status handling and `playItem` logic.

## [1.0.2] - 2026-01-18

### Added

- Support for queueing a playback item.

## [1.0.1] - 2026-01-18

### Added

- Image caching.

## [1.0.0] - 2026-01-18

### Added

- Initial release: Roon integration for Linux with MPRIS support, media keys, desktop
  notifications and an interactive search CLI.
