// @ts-expect-error
import Player from "mpris-service";

import { cacheImage } from "./image-cache";
import { parseNowPlaying } from "./roon";

let mpris: any = null;

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

export async function updateMprisMetadata(zone: any, core: any) {
    if (!mpris) return;

    if (!zone || !zone.now_playing) {
        mpris.metadata = {};
        mpris.playbackStatus = "Stopped";
        return;
    }

    const np = zone.now_playing;
    const data = parseNowPlaying(np);

    // Update playback state and metadata immediately (before async image caching)
    // so MPRIS clients see the state change without delay
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

    const trackId = np.image_key || "0";
    const baseMetadata = {
        "mpris:trackid": mpris.objectPath(`track/${trackId}`),
        "xesam:title": data.title,
        "xesam:artist": data.artists,
        "xesam:album": data.album,
        "mpris:length": (np.length || 0) * 1_000_000,
    };

    // Set metadata immediately so MPRIS clients see the change without delay
    mpris.metadata = baseMetadata;

    // Then cache artwork and update metadata with artUrl if available
    if (np.image_key && core?.services?.RoonApiImage) {
        try {
            const artworkPath = await cacheImage(core.services.RoonApiImage, np.image_key);
            if (artworkPath) {
                mpris.metadata = { ...baseMetadata, "mpris:artUrl": `file://${artworkPath}` };
            }
        } catch (_err) {
            // Artwork failed to cache, metadata already set without it
        }
    }
}

export function updateMprisSeek(seekPosition: number) {
    if (!mpris) return;
    mpris.seeked(seekPosition);
}
