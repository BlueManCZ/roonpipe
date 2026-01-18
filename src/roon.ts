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

export function initRoon(callbacks: RoonCallbacks) {
    const roon = new RoonApi({
        extension_id: "com.bluemancz.roonpipe",
        display_name: "RoonPipe",
        display_version: "1.0.2",
        publisher: "BlueManCZ",
        email: "your@email.com",
        website: "https://github.com/bluemancz/roonpipe",
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
                        if (seekUpdate && zone) {
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

    roon.init_services({
        required_services: [RoonApiBrowse, RoonApiImage, RoonApiTransport],
    });

    roon.start_discovery();
}

export interface SearchResult {
    title: string;
    subtitle: string;
    item_key: string;
    image_key: string;
    image: string | null;
    hint: string;
    sessionKey: string;
}

export function searchRoon(query: string): Promise<SearchResult[]> {
    return new Promise((resolve, reject) => {
        if (!coreInstance) {
            reject("Roon Core not connected");
            return;
        }

        if (!zone) {
            reject("No active zone");
            return;
        }

        const browse = coreInstance.services.RoonApiBrowse;
        const sessionKey = `search_${Date.now()}`;

        const opts = {
            hierarchy: "search",
            input: query,
            multi_session_key: sessionKey,
            zone_or_output_id: zone.zone_id,
        };

        browse.browse(opts, (error: any, result: any) => {
            if (error) {
                reject(error);
                return;
            }

            browse.load(
                {
                    ...opts,
                    offset: 0,
                    count: result.list.count,
                },
                (loadError: any, loadResult: any) => {
                    if (loadError) {
                        reject(loadError);
                        return;
                    }

                    const tracksCategory = loadResult.items?.find(
                        (item: any) => item.title === "Tracks",
                    );

                    if (!tracksCategory) {
                        // No tracks category found - return an empty array
                        resolve([]);
                        return;
                    }

                    browse.browse(
                        {
                            ...opts,
                            item_key: tracksCategory.item_key,
                        },
                        (browseError: any, browseResult: any) => {
                            if (browseError) {
                                reject(browseError);
                                return;
                            }

                            browse.load(
                                {
                                    ...opts,
                                    item_key: tracksCategory.item_key,
                                    offset: 0,
                                    count: Math.min(browseResult.list.count, 50),
                                },
                                async (tracksError: any, tracksResult: any) => {
                                    if (tracksError) {
                                        reject(tracksError);
                                        return;
                                    }

                                    // Cache all images in parallel
                                    const imageKeys =
                                        tracksResult.items
                                            ?.map((item: any) => item.image_key)
                                            .filter(Boolean) || [];

                                    const imageApi = coreInstance.services.RoonApiImage;
                                    const cachedImages = await cacheImages(imageApi, imageKeys);

                                    const items: SearchResult[] =
                                        tracksResult.items?.map((item: any) => ({
                                            title: item.title || "Unknown",
                                            subtitle: item.subtitle || "",
                                            item_key: item.item_key,
                                            image_key: item.image_key,
                                            image: cachedImages.get(item.image_key) || null,
                                            hint: item.hint,
                                            sessionKey: sessionKey,
                                        })) || [];

                                    resolve(items);
                                },
                            );
                        },
                    );
                },
            );
        });
    });
}

export type PlayAction = "play" | "playNow" | "queue" | "addNext";

const ACTION_TITLES: Record<Exclude<PlayAction, "playNow">, string[]> = {
    play: ["Play Now", "Play"],
    queue: ["Queue", "Add to Queue"],
    addNext: ["Play From Here", "Add Next"],
};

/**
 * Skip to the next track in the queue
 */
function skipToNext(): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!coreInstance || !zone) {
            reject("Not connected");
            return;
        }
        coreInstance.services.RoonApiTransport.control(zone, "next", (err: any) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

export async function playItem(
    itemKey: string,
    sessionKey: string,
    action: PlayAction = "play",
): Promise<void> {
    // "playNow" = add next + skip to it (preserves queue)
    if (action === "playNow") {
        await playItemInternal(itemKey, sessionKey, "addNext");
        await skipToNext();
        return;
    }

    return playItemInternal(itemKey, sessionKey, action);
}

function playItemInternal(
    itemKey: string,
    sessionKey: string,
    action: Exclude<PlayAction, "playNow">,
): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!coreInstance) {
            reject("Roon Core not connected");
            return;
        }

        if (!zone) {
            reject("No active zone");
            return;
        }

        const browse = coreInstance.services.RoonApiBrowse;
        const actionTitles = ACTION_TITLES[action];

        function loadUntilAction(currentItemKey: string, depth: number = 0) {
            if (depth > 5) {
                reject("Too many levels, cannot find action");
                return;
            }

            browse.browse(
                {
                    hierarchy: "search",
                    multi_session_key: sessionKey,
                    item_key: currentItemKey,
                    zone_or_output_id: zone.zone_id,
                },
                (browseError: any, browseResult: any) => {
                    if (browseError) {
                        reject(browseError);
                        return;
                    }

                    browse.load(
                        {
                            hierarchy: "search",
                            multi_session_key: sessionKey,
                            item_key: currentItemKey,
                            offset: 0,
                            count: browseResult.list?.count || 10,
                            zone_or_output_id: zone.zone_id,
                        },
                        (loadError: any, loadResult: any) => {
                            if (loadError) {
                                reject(loadError);
                                return;
                            }

                            if (!loadResult.items || loadResult.items.length === 0) {
                                reject("No items found");
                                return;
                            }

                            const targetAction = loadResult.items.find(
                                (item: any) =>
                                    item.hint === "action" &&
                                    actionTitles.some((title) => item.title === title),
                            );

                            if (targetAction) {
                                browse.browse(
                                    {
                                        hierarchy: "search",
                                        multi_session_key: sessionKey,
                                        item_key: targetAction.item_key,
                                        zone_or_output_id: zone.zone_id,
                                    },
                                    (playError: any) => {
                                        if (playError) {
                                            reject(playError);
                                        } else {
                                            console.log(`Successfully executed action: ${action}`);
                                            resolve();
                                        }
                                    },
                                );
                            } else {
                                const actionList = loadResult.items.find(
                                    (item: any) => item.hint === "action_list",
                                );

                                if (actionList) {
                                    loadUntilAction(actionList.item_key, depth + 1);
                                } else {
                                    reject(`Could not find ${action} action or next level`);
                                }
                            }
                        },
                    );
                },
            );
        }

        loadUntilAction(itemKey);
    });
}

export function getZone() {
    return zone;
}

export function getCore() {
    return coreInstance;
}
