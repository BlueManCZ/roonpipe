import { execSync } from "node:child_process";

import { cacheImage } from "./image-cache";
import { parseNowPlaying } from "./roon";

let lastNotifiedTrack: string | null = null;
let lastState: string | null = null;
let isFirstUpdate = true;

/**
 * Show a desktop notification for the current track.
 * - Skips notification on startup if a track is already playing
 * - Shows notification when the playback starts
 */
export async function showTrackNotification(zone: any, core: any) {
    if (!zone?.now_playing) return;

    const trackId = zone.now_playing.image_key || "";
    const isPlaying = zone.state === "playing";

    // Skip notification on startup if already playing
    if (isFirstUpdate) {
        isFirstUpdate = false;
        lastNotifiedTrack = trackId;
        lastState = zone.state;
        return;
    }

    const prevState = lastState;
    // Notify only when playback actually starts (transition into "playing").
    const playbackStarted = isPlaying && prevState !== "playing";
    const trackChanged = trackId !== lastNotifiedTrack;

    // Notify when playback started OR when track changed while already playing
    const shouldNotify = playbackStarted || (trackChanged && isPlaying);

    if (!shouldNotify) {
        // nothing to notify, but update lastState for transition tracking
        lastState = zone.state;
        return;
    }

    try {
        // Build now-playing data once
        const data = parseNowPlaying(zone.now_playing);

        // Cache artwork if available
        let artworkPath: string | null = null;
        if (zone.now_playing.image_key && core?.services?.RoonApiImage) {
            try {
                artworkPath = await cacheImage(
                    core.services.RoonApiImage,
                    zone.now_playing.image_key,
                );
            } catch (_err) {
                artworkPath = null;
            }
        }

        const args = [
            `--app-name=Roon`,
            `--icon=audio-x-generic`,
            `--replace-id=1`,
            `--hint=int:transient:1`,
            ...(artworkPath ? [`--hint=string:image-path:${artworkPath}`] : []),
            `--expire-time=5000`,
            data.title,
            `${data.artists.join(", ")} • ${data.album}`,
        ];

        console.log(`Showing notification for track: ${data.title}`);
        execSync(`notify-send ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`);

        lastNotifiedTrack = trackId;
        lastState = zone.state;
    } catch (err) {
        console.error("Failed to show notification:", err);
    }
}
