import fs from "node:fs";
// @ts-expect-error
import Player from "mpris-service";
import notifier from "node-notifier";

let mpris: any = null;
let lastNotifiedTrack: string | null = null;
let isInitialLoad = true;
let lastPlaybackState: string | null = null;

const artworkPath = "/tmp/roon-mpris-cover.jpg";

const loopMap = {
    // Roon -> MPRIS
    loop_one: "Track",
    loop: "Playlist",
    disabled: "None",
    next: "None",
    // MPRIS -> Roon
    Track: "loop_one",
    Playlist: "loop",
    None: "disabled",
} as const;

type LoopType = keyof typeof loopMap;

function convertRoonLoopToMPRIS(roonLoop: LoopType) {
    return loopMap[roonLoop] || "None";
}

function convertMPRISLoopToRoon(mprisLoop: LoopType) {
    return loopMap[mprisLoop] || "disabled";
}

export function initMpris(getTransport: () => any, getZone: () => any) {
    // Helper to call Roon transport functions
    function roonCallback(fn: (transport: any, zone: any) => void) {
        const transport = getTransport();
        const zone = getZone();
        if (transport && zone) {
            fn(transport, zone);
        }
    }

    mpris = Player({
        name: "roon",
        identity: "Roon",
        supportedUriSchemes: ["file"],
        supportedMimeTypes: ["audio/mpeg", "application/ogg"],
        supportedInterfaces: ["player"],
    });

    // Wire up all MPRIS events
    const events = [
        "play",
        "pause",
        "stop",
        "playpause",
        "next",
        "previous",
        "seek",
        "position",
        "volume",
        "loopStatus",
        "shuffle",
        "open",
    ] as const;

    events.forEach((event) => {
        mpris.on(event, (data: any) => {
            switch (event) {
                case "seek":
                    roonCallback((t, z) => t.seek(z, "relative", data / 1_000_000));
                    break;

                case "position":
                    roonCallback((t, z) => t.seek(z, "absolute", data.position / 1_000_000));
                    break;

                case "volume":
                    roonCallback((t, z) => {
                        if (!z.outputs?.[0]?.volume) return;
                        const output = z.outputs[0];
                        const vol = output.volume;
                        const roonVolume = vol.min + data * (vol.max - vol.min);
                        t.change_volume(output, "absolute", Math.round(roonVolume));
                    });
                    break;

                case "loopStatus":
                    roonCallback((t, z) =>
                        t.change_settings(z, { loop: convertMPRISLoopToRoon(data) }),
                    );
                    break;

                case "shuffle":
                    roonCallback((t, z) => t.change_settings(z, { shuffle: data }));
                    break;

                case "open":
                    console.log("MPRIS command: open", data.uri);
                    break;

                default:
                    roonCallback((t, z) => t.control(z, event));
                    break;
            }
        });
    });

    // Position getter - dynamically reads from zone
    mpris.getPosition = () => {
        const zone = getZone();
        return zone?.now_playing?.seek_position ? zone.now_playing.seek_position * 1_000_000 : 0;
    };

    // Set initial states
    mpris.canControl = true;
    mpris.canPlay = true;
    mpris.canPause = true;
    mpris.canGoNext = true;
    mpris.canGoPrevious = true;
    mpris.canSeek = true;
    mpris.playbackStatus = "Stopped";

    console.log("MPRIS player initialized");
}

function fetchArtwork(core: any, imageKey: string, callback: () => void) {
    const image = core.services.RoonApiImage;

    image.get_image(
        imageKey,
        { scale: "fit", width: 256, height: 256, format: "image/jpeg" },
        (error: any, _contentType: string, imageData: Buffer) => {
            if (error) {
                console.error("Failed to fetch artwork:", error);
                return;
            }

            fs.writeFileSync(artworkPath, imageData);
            console.log("Artwork saved to", artworkPath);
            callback();
        },
    );
}

function showTrackNotification(zone: any) {
    if (!zone || !zone.now_playing) return;

    const np = zone.now_playing;
    const trackId = np.image_key || "";
    const currentState = zone.state;

    // Skip notification on an initial load
    if (isInitialLoad) {
        lastNotifiedTrack = trackId;
        lastPlaybackState = currentState;
        isInitialLoad = false;
        return;
    }

    // Show notification if the track changed or started playing
    const trackChanged = trackId !== lastNotifiedTrack;
    const startedPlaying = currentState === "playing" && lastPlaybackState !== "playing";

    if (trackChanged || startedPlaying) {
        lastNotifiedTrack = trackId;

        notifier.notify({
            title: np.three_line?.line1 || "Unknown Track",
            message: `${np.three_line?.line2 || "Unknown Artist"}\n${np.three_line?.line3 || ""}`,
            timeout: 5,
            icon: artworkPath,
            hint: "string:x-canonical-private-synchronous:roonpipe",
        });
    }

    lastPlaybackState = currentState;
}

function updateVolume(zone: any) {
    if (!mpris) return;

    if (!zone || !zone.outputs || zone.outputs.length === 0) {
        mpris.volume = 0;
        return;
    }

    const output = zone.outputs[0];
    if (!output.volume) {
        mpris.volume = 0;
        return;
    }

    const vol = output.volume;
    mpris.volume = (vol.value - vol.min) / (vol.max - vol.min);
}

export function updateMprisMetadata(zone: any, core: any) {
    if (!mpris) return;

    if (!zone || !zone.now_playing) {
        mpris.metadata = {};
        return;
    }

    const np = zone.now_playing;

    // Fetch artwork if image_key exists
    if (np.image_key) {
        fetchArtwork(core, np.image_key, () => {
            showTrackNotification(zone);
        });
    }

    mpris.metadata = {
        "mpris:trackid": mpris.objectPath(`track/${np.image_key || "0"}`),
        "xesam:title": np.three_line?.line1 || "Unknown",
        "xesam:artist": np.three_line?.line2 ? [np.three_line.line2] : [],
        "xesam:album": np.three_line?.line3 || "",
        "mpris:length": (np.length || 0) * 1_000_000,
        "mpris:artUrl": `file://${artworkPath}`,
    };

    // For playpause to work, we need canPlay OR canPause to be true
    // When playing: is_pause_allowed=true, is_play_allowed=false
    // When paused: is_pause_allowed=false, is_play_allowed=true
    // We set both to true if either action is allowed, so playpause always works
    const canTogglePlayback = zone.is_play_allowed || zone.is_pause_allowed;
    mpris.canPlay = canTogglePlayback;
    mpris.canPause = canTogglePlayback;
    mpris.canGoNext = zone.is_next_allowed;
    mpris.canGoPrevious = zone.is_previous_allowed;
    mpris.playbackStatus = zone.state === "playing" ? "Playing" : "Paused";
    mpris.loopStatus = convertRoonLoopToMPRIS(zone.settings.loop);
    mpris.shuffle = zone.settings.shuffle;
    mpris.canSeek = zone.is_seek_allowed;

    updateVolume(zone);
}

export function updateMprisSeek(seekPosition: number) {
    if (!mpris) return;
    mpris.seeked(seekPosition);
}
