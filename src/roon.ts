// @ts-expect-error
import RoonApi from "node-roon-api";
// @ts-expect-error
import RoonApiBrowse from "node-roon-api-browse";
// @ts-expect-error
import RoonApiImage from "node-roon-api-image";
// @ts-expect-error
import RoonApiTransport from "node-roon-api-transport";

import { cacheImages } from "./image-cache";

let zone: any = null;
let coreInstance: any = null;

export interface RoonCallbacks {
    onCorePaired: (core: any) => void;
    onCoreUnpaired: (core: any) => void;
    onZoneChanged: (zone: any, core: any) => void;
    onSeekChanged: (seekPosition: number) => void;
}

export const parseNowPlaying = (nowPlaying: any) => {
    const title = nowPlaying.three_line?.line1 || "Unknown Track";

    // Split artists by "/" separator and select first (Roon provides multiple artists in one string)
    const artists = nowPlaying.three_line?.line2
        ? [nowPlaying.three_line.line2.split(" / ").map((a: string) => a.trim())[0]]
        : ["Unknown Artist"]; // TODO: Let user choose format

    const album = nowPlaying.three_line?.line3 || "";

    return { title, artists, album };
};

export function initRoon(callbacks: RoonCallbacks) {
    const roon = new RoonApi({
        extension_id: "com.bluemancz.roonpipe",
        display_name: "RoonPipe",
        display_version: "1.0.4",
        publisher: "BlueManCZ",
        email: "your@email.com",
        website: "https://github.com/bluemancz/roonpipe",
        log_level: "none",
        core_paired: (core: any) => {
            coreInstance = core;
            const transport = core.services.RoonApiTransport;

            transport.subscribe_zones((cmd: any, data: any) => {
                if (cmd === "Subscribed") {
                    zone = data.zones.find((z: any) => z.state === "playing") || data.zones[0];
                    callbacks.onZoneChanged(zone, core);
                } else if (cmd === "Changed") {
                    if (data.zones_changed) {
                        const playingZone = data.zones_changed.find(
                            (z: any) => z.state === "playing",
                        );
                        if (playingZone) {
                            zone = playingZone;
                        } else if (zone) {
                            zone =
                                data.zones_changed.find((z: any) => z.zone_id === zone.zone_id) ||
                                zone;
                        }
                        callbacks.onZoneChanged(zone, core);
                    }
                    if (data.zones_seek_changed) {
                        const seekUpdate = data.zones_seek_changed.find(
                            (z: any) => z.zone_id === zone?.zone_id,
                        );
                        if (seekUpdate && zone?.now_playing) {
                            zone.now_playing.seek_position = seekUpdate.seek_position;
                            callbacks.onSeekChanged(seekUpdate.seek_position * 1_000_000);
                        }
                    }
                }
            });

            callbacks.onCorePaired(core);
            console.log(`Core paired: ${core.display_name}`);
        },
        core_unpaired: (core: any) => {
            zone = null;
            coreInstance = null;
            callbacks.onCoreUnpaired(core);
            console.log(`Core unpaired: ${core.display_name}`);
        },
    });

    roon.init_services({ required_services: [RoonApiBrowse, RoonApiImage, RoonApiTransport] });
    roon.start_discovery();
}

export interface SearchResult {
    title: string;
    subtitle: string;
    item_key: string;
    image: string | null;
    hint: string;
    sessionKey: string;
}

function browsePromise(browse: any, opts: any): Promise<any> {
    return new Promise((resolve, reject) => {
        browse.browse(opts, (error: any, result: any) => {
            if (error) reject(error);
            else resolve(result);
        });
    });
}

function loadPromise(browse: any, opts: any): Promise<any> {
    return new Promise((resolve, reject) => {
        browse.load(opts, (error: any, result: any) => {
            if (error) reject(error);
            else resolve(result);
        });
    });
}

export async function searchRoon(query: string): Promise<SearchResult[]> {
    if (!coreInstance) throw new Error("Roon Core not connected");
    if (!zone) throw new Error("No active zone");

    const browse = coreInstance.services.RoonApiBrowse;
    const sessionKey = `search_${Date.now()}`;
    const baseOpts = {
        hierarchy: "search",
        input: query,
        multi_session_key: sessionKey,
        zone_or_output_id: zone.zone_id,
    };

    const result = await browsePromise(browse, baseOpts);
    const loadResult = await loadPromise(browse, {
        ...baseOpts,
        offset: 0,
        count: result.list.count,
    });

    const tracksCategory = loadResult.items?.find((item: any) => item.title === "Tracks");
    if (!tracksCategory) return [];

    const browseResult = await browsePromise(browse, {
        ...baseOpts,
        item_key: tracksCategory.item_key,
    });
    const tracksResult = await loadPromise(browse, {
        ...baseOpts,
        item_key: tracksCategory.item_key,
        offset: 0,
        count: Math.min(browseResult.list.count, 50),
    });

    const imageKeys = tracksResult.items?.map((item: any) => item.image_key).filter(Boolean) || [];
    const cachedImages = await cacheImages(coreInstance.services.RoonApiImage, imageKeys);

    return (
        tracksResult.items?.map((item: any) => ({
            title: item.title || "Unknown Track",
            subtitle: item.subtitle ? item.subtitle.split(", ")[0] : "Unknown Artist", // TODO: Let user choose format
            item_key: item.item_key,
            image: cachedImages.get(item.image_key) || null,
            hint: item.hint,
            sessionKey,
        })) || []
    );
}

export type PlayAction = "play" | "playNow" | "queue" | "addNext";

const ACTION_TITLES: Record<Exclude<PlayAction, "playNow">, string[]> = {
    play: ["Play Now", "Play"],
    queue: ["Queue", "Add to Queue"],
    addNext: ["Play From Here", "Add Next"],
};

function controlPromise(transport: any, zone: any, command: string): Promise<void> {
    return new Promise((resolve, reject) => {
        transport.control(zone, command, (err: any) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

/**
 * Check if there's an active queue (something is playing or paused)
 */
function hasActiveQueue(): boolean {
    return !!zone?.now_playing && (zone.state === "playing" || zone.state === "paused");
}

export async function playItem(
    itemKey: string,
    sessionKey: string,
    action: PlayAction = "play",
): Promise<void> {
    // "playNow" = preserve the queue if possible.
    if (action === "playNow") {
        if (hasActiveQueue()) {
            // If the queue exists: add next + skip to it
            await playItemInternal(itemKey, sessionKey, "addNext");
            await controlPromise(coreInstance.services.RoonApiTransport, zone, "next");
        } else {
            // If no queue: use the regular "Play now" action
            await playItemInternal(itemKey, sessionKey, "play");
        }
        return;
    }
    return playItemInternal(itemKey, sessionKey, action);
}

async function playItemInternal(
    itemKey: string,
    sessionKey: string,
    action: Exclude<PlayAction, "playNow">,
): Promise<void> {
    if (!coreInstance) throw new Error("Roon Core not connected");
    if (!zone) throw new Error("No active zone");

    const browse = coreInstance.services.RoonApiBrowse;
    const actionTitles = ACTION_TITLES[action];

    async function findAndExecute(currentItemKey: string, depth = 0): Promise<void> {
        if (depth > 5) throw new Error("Too many levels, cannot find action");

        const browseResult = await browsePromise(browse, {
            hierarchy: "search",
            multi_session_key: sessionKey,
            item_key: currentItemKey,
            zone_or_output_id: zone.zone_id,
        });

        const loadResult = await loadPromise(browse, {
            hierarchy: "search",
            multi_session_key: sessionKey,
            item_key: currentItemKey,
            offset: 0,
            count: browseResult.list?.count || 10,
            zone_or_output_id: zone.zone_id,
        });

        if (!loadResult.items?.length) throw new Error("No items found");

        const targetAction = loadResult.items.find(
            (item: any) =>
                item.hint === "action" && actionTitles.some((title) => item.title === title),
        );

        if (targetAction) {
            await browsePromise(browse, {
                hierarchy: "search",
                multi_session_key: sessionKey,
                item_key: targetAction.item_key,
                zone_or_output_id: zone.zone_id,
            });
            console.log(`Successfully executed action: ${action}`);
        } else {
            const actionList = loadResult.items.find((item: any) => item.hint === "action_list");
            if (actionList) {
                await findAndExecute(actionList.item_key, depth + 1);
            } else {
                throw new Error(`Could not find ${action} action or next level`);
            }
        }
    }

    await findAndExecute(itemKey);
}

export function getZone() {
    return zone;
}
export function getCore() {
    return coreInstance;
}
