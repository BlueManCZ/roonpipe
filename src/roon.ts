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

export interface RoonAction {
    title: string;
}

export interface SearchResult {
    title: string;
    subtitle: string;
    item_key: string;
    image: string | null;
    hint: string;
    sessionKey: string;
    type: "track" | "album" | "artist" | "composer" | "playlist" | "work";
    category_key: string;
    index: number;
    actions: RoonAction[];
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

async function discoverActions(
    browse: any,
    itemKey: string,
    sessionKey: string,
    zoneId: string,
    depth = 0,
): Promise<RoonAction[]> {
    if (depth > 5) return [];

    try {
        const browseResult = await browsePromise(browse, {
            hierarchy: "search",
            multi_session_key: sessionKey,
            item_key: itemKey,
            zone_or_output_id: zoneId,
        });

        // Get the current session key after browsing to this item
        const currentSessionKey = browseResult.list?.multi_session_key || sessionKey;
        console.log(
            `[DEBUG] discoverActions: itemKey=${itemKey}, currentSessionKey=${currentSessionKey}, depth=${depth}`,
        );

        const loadResult = await loadPromise(browse, {
            hierarchy: "search",
            multi_session_key: currentSessionKey,
            item_key: itemKey,
            offset: 0,
            count: browseResult.list?.count || 50,
            zone_or_output_id: zoneId,
        });

        if (!loadResult.items?.length) return [];

        const actions: RoonAction[] = [];

        for (const item of loadResult.items) {
            console.log(`[DEBUG] discoverActions item: title=${item.title}, hint=${item.hint}`);
            if (item.hint === "action") {
                actions.push({
                    title: item.title,
                });
            } else if (item.hint === "action_list" || item.hint === "header") {
                // Recurse into action_list and header items to find actions
                const subActions = await discoverActions(
                    browse,
                    item.item_key,
                    currentSessionKey,
                    zoneId,
                    depth + 1,
                );
                actions.push(...subActions);
                // For albums: stop after finding the first action_list (don't recurse into all tracks)
                if (depth === 1 && item.hint === "action_list" && actions.length > 0) {
                    break;
                }
            } else if (item.hint === "list" && depth === 0 && loadResult.items.length === 1) {
                // For albums: when we get a single "list" item at depth 0, recurse into it
                // This handles the case where an album contains itself as a list before showing actions
                const subActions = await discoverActions(
                    browse,
                    item.item_key,
                    currentSessionKey,
                    zoneId,
                    depth + 1,
                );
                actions.push(...subActions);
            }
        }

        return actions;
    } catch (error) {
        return [];
    }
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

    const results: SearchResult[] = [];
    const maxResultsPerCategory = 5;

    for (const category of loadResult.items) {
        const browseResult = await browsePromise(browse, {
            ...baseOpts,
            item_key: category.item_key,
        });
        const itemsResult = await loadPromise(browse, {
            ...baseOpts,
            item_key: category.item_key,
            offset: 0,
            count: Math.min(browseResult.list.count, maxResultsPerCategory),
        });

        const imageKeys =
            itemsResult.items?.map((item: any) => item.image_key).filter(Boolean) || [];
        const cachedImages = await cacheImages(coreInstance.services.RoonApiImage, imageKeys);

        const knownCategories = ["artist", "album", "composer", "playlist", "track", "work"];

        // Infer type from category title
        if (!category.title) continue;
        let type: "track" | "album" | "artist" | "composer" | "playlist" | "work" = "track";
        if (
            knownCategories.some((knownCategory) =>
                category.title.toLowerCase().includes(knownCategory),
            )
        ) {
            type = knownCategories.find((knownCategory) =>
                category.title.toLowerCase().includes(knownCategory),
            ) as typeof type;
        } else {
            type = category.title;
        }

        // Discover actions for each item
        const categoryResults = [];
        for (let index = 0; index < (itemsResult.items?.length || 0); index++) {
            const item = itemsResult.items[index];
            const actions = await discoverActions(browse, item.item_key, sessionKey, zone.zone_id);

            categoryResults.push({
                title: item.title || `Unknown ${type.charAt(0).toUpperCase() + type.slice(1)}`,
                subtitle: item.subtitle?.split(", ")[0] || "",
                item_key: item.item_key,
                image: cachedImages.get(item.image_key) || null,
                hint: item.hint,
                sessionKey,
                type,
                category_key: category.item_key,
                index,
                actions,
            });
        }

        results.push(...categoryResults);
    }

    return results;
}

export async function playItem(
    itemKey: string,
    sessionKey: string,
    categoryKey: string,
    itemIndex: number,
    actionTitle: string,
): Promise<void> {
    if (!coreInstance) throw new Error("Roon Core not connected");
    if (!zone) throw new Error("No active zone");

    const browse = coreInstance.services.RoonApiBrowse;

    console.log(
        `[DEBUG] playItem: itemKey=${itemKey}, categoryKey=${categoryKey}, itemIndex=${itemIndex}, actionTitle=${actionTitle}`,
    );

    // Navigate to category
    await browsePromise(browse, {
        hierarchy: "search",
        multi_session_key: sessionKey,
        item_key: categoryKey,
        zone_or_output_id: zone.zone_id,
    });

    // Load the specific item
    const loadResult = await loadPromise(browse, {
        hierarchy: "search",
        multi_session_key: sessionKey,
        item_key: categoryKey,
        offset: itemIndex,
        count: 1,
        zone_or_output_id: zone.zone_id,
    });

    if (!loadResult.items?.[0]) {
        throw new Error("Item not found at index");
    }

    const actualItemKey = loadResult.items[0].item_key;
    console.log(`[DEBUG] Got fresh item_key: ${actualItemKey}`);

    // Discover actions with fresh context
    const actions = await discoverActions(browse, actualItemKey, sessionKey, zone.zone_id);
    console.log(
        `[DEBUG] Discovered ${actions.length} actions:`,
        actions.map((a) => a.title).join(", "),
    );

    // Find the action by title
    const targetAction = actions.find((a) => a.title === actionTitle);
    if (!targetAction) {
        throw new Error(`Action "${actionTitle}" not found`);
    }

    // Now navigate through the same structure to find and execute the action
    // We need to recursively find the action item with fresh keys
    async function findAndExecuteAction(
        currentItemKey: string,
        currentSessionKey: string,
        depth: number = 0,
    ): Promise<boolean> {
        if (depth > 5) return false;

        const browseResult = await browsePromise(browse, {
            hierarchy: "search",
            multi_session_key: currentSessionKey,
            item_key: currentItemKey,
            zone_or_output_id: zone.zone_id,
        });

        const newSessionKey = browseResult.list?.multi_session_key || currentSessionKey;

        const loadResult = await loadPromise(browse, {
            hierarchy: "search",
            multi_session_key: newSessionKey,
            item_key: currentItemKey,
            offset: 0,
            count: browseResult.list?.count || 50,
            zone_or_output_id: zone.zone_id,
        });

        if (!loadResult.items?.length) return false;

        for (const item of loadResult.items) {
            console.log(`[DEBUG] Navigating: title=${item.title}, hint=${item.hint}`);

            if (item.hint === "action" && item.title === actionTitle) {
                console.log(`[DEBUG] Found action! Executing: ${item.title} (${item.item_key})`);
                await browsePromise(browse, {
                    hierarchy: "search",
                    multi_session_key: newSessionKey,
                    item_key: item.item_key,
                    zone_or_output_id: zone.zone_id,
                });
                console.log("[DEBUG] Successfully executed action");
                return true;
            } else if (
                item.hint === "action_list" ||
                (item.hint === "list" && loadResult.items.length === 1)
            ) {
                // Recurse into this item
                const found = await findAndExecuteAction(item.item_key, newSessionKey, depth + 1);
                if (found) return true;

                // For albums: stop after checking the first action_list
                if (depth === 1 && item.hint === "action_list") {
                    break;
                }
            }
        }

        return false;
    }

    const found = await findAndExecuteAction(actualItemKey, sessionKey);
    if (!found) {
        throw new Error(`Could not find action "${actionTitle}" to execute`);
    }
}

export function getZone() {
    return zone;
}
export function getCore() {
    return coreInstance;
}
