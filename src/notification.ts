import { execSync } from "node:child_process";

import { cacheImage } from "./image-cache";
import { parseNowPlaying } from "./roon";

let lastNotifiedTrack: string | null = null;
let notificationTimeout: ReturnType<typeof setTimeout> | null = null;
let isFirstUpdate = true;
let lastPlaybackState: string | null = null;

/**
 * Show a desktop notification for the current track.
 * - Skips notification on startup if a track is already playing
 * - Shows notification when the playback starts
 * - Shows notification when the track changes
 */
export async function showTrackNotification(zone: any, core: any) {
    if (!zone?.now_playing) return;

    const np = zone.now_playing;
    const trackId = np.image_key || "";
    const currentState = zone.state;

    // Skip notification on startup if the track is already playing
    if (isFirstUpdate) {
        isFirstUpdate = false;
        lastNotifiedTrack = trackId;
        lastPlaybackState = currentState;
        return;
    }

    const trackChanged = trackId !== lastNotifiedTrack;
    const playbackStarted = currentState === "playing" && lastPlaybackState !== "playing";

    lastPlaybackState = currentState;

    // Show notification on track change or playback start
    if (!trackChanged && !playbackStarted) return;

    // Cancel any pending notification
    if (notificationTimeout) {
        clearTimeout(notificationTimeout);
    }

    // Debounce to prevent duplicate notifications
    notificationTimeout = setTimeout(async () => {
        // Skip if already notified for this track
        if (trackId === lastNotifiedTrack) {
            notificationTimeout = null;
            return;
        }

        lastNotifiedTrack = trackId;

        const data = parseNowPlaying(np);

        // Cache the artwork
        let artworkPath: string | null = null;
        if (np.image_key && core?.services?.RoonApiImage) {
            artworkPath = await cacheImage(core.services.RoonApiImage, np.image_key);
        }

        console.log("Showing notification for track:", data.title);

        const args = [
            "--app-name=Roon",
            "--icon=audio-x-generic",
            "--hint=int:transient:1",
            ...(artworkPath ? [`--hint=string:image-path:${artworkPath}`] : []),
            "--expire-time=5000",
            data.title,
            `${data.artists.join(", ")}\n${data.album}`,
        ];

        try {
            execSync(`notify-send ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`);
        } catch (error) {
            console.error("Failed to show notification:", error);
        }

        notificationTimeout = null;
    }, 150);
}
