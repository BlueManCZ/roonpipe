// @ts-expect-error
import RoonApi from "node-roon-api";
// @ts-expect-error
import RoonApiBrowse from "node-roon-api-browse";
// @ts-expect-error
import RoonApiImage from "node-roon-api-image";
// @ts-expect-error
import RoonApiTransport from "node-roon-api-transport";

import { recordPlay, reRankResults } from "./frequency";
import { cacheImages } from "./image-cache";

let zone: any = null;
let coreInstance: any = null;

// Cached copy of the active zone's play queue, kept in sync via a Roon queue
// subscription (the transport API has no synchronous getter). ``queueZoneId``
// tracks which zone the subscription is bound to so we only re-subscribe when
// the active zone actually changes.
const QUEUE_MAX_ITEMS = 100;
let queue: any[] = [];
let queueSub: { unsubscribe: (cb?: any) => void } | null = null;
let queueZoneId: string | null = null;

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

// Apply the incremental ``changes`` from a queue "Changed" message to the
// cached queue. Roon sends ordered remove/insert operations against the
// current list rather than a full snapshot.
function applyQueueChanges(changes: any[]) {
    for (const change of changes) {
        if (change.operation === "remove") {
            queue.splice(change.index, change.count);
        } else if (change.operation === "insert") {
            queue.splice(change.index, 0, ...(change.items || []));
        }
    }
}

// (Re)subscribe to the queue of the active zone. No-op if already subscribed to
// the same zone; tears down the previous subscription when the zone changes so
// the cached queue always reflects whatever is currently playing.
function subscribeQueue(core: any, targetZone: any) {
    const transport = core?.services?.RoonApiTransport;
    if (!transport || !targetZone) return;
    if (queueSub && queueZoneId === targetZone.zone_id) return;

    if (queueSub) {
        try {
            queueSub.unsubscribe();
        } catch (_) {
            // Ignore errors tearing down a stale subscription
        }
    }
    queue = [];
    queueZoneId = targetZone.zone_id;
    queueSub = transport.subscribe_queue(targetZone, QUEUE_MAX_ITEMS, (cmd: any, data: any) => {
        if (cmd === "Subscribed") {
            queue = data.items || [];
        } else if (cmd === "Changed" && data.changes) {
            applyQueueChanges(data.changes);
        } else if (cmd === "Unsubscribed") {
            queue = [];
        }
    });
}

function resetQueue() {
    if (queueSub) {
        try {
            queueSub.unsubscribe();
        } catch (_) {
            // Ignore errors tearing down a stale subscription
        }
    }
    queueSub = null;
    queueZoneId = null;
    queue = [];
}

export function initRoon(callbacks: RoonCallbacks) {
    const roon = new RoonApi({
        extension_id: "com.bluemancz.roonpipe",
        display_name: "RoonPipe",
        display_version: "1.0.14",
        publisher: "BlueManCZ",
        email: "your@email.com",
        website: "https://github.com/bluemancz/roonpipe",
        log_level: "none",
        core_paired: (core: any) => {
            coreInstance = core;
            const transport = core.services.RoonApiTransport;

            // Notify listeners of a zone change and keep the queue subscription
            // bound to whatever zone is now active.
            const emitZoneChanged = (z: any) => {
                callbacks.onZoneChanged(z, core);
                subscribeQueue(core, z);
            };

            transport.subscribe_zones((cmd: any, data: any) => {
                if (cmd === "Subscribed") {
                    zone = data.zones.find((z: any) => z.state === "playing") || data.zones[0];
                    emitZoneChanged(zone);
                } else if (cmd === "Changed") {
                    if (data.zones_added && !zone) {
                        zone =
                            data.zones_added.find((z: any) => z.state === "playing") ||
                            data.zones_added[0];
                        emitZoneChanged(zone);
                    }
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
                        } else {
                            zone = data.zones_changed[0];
                        }
                        emitZoneChanged(zone);
                    }
                    if (data.zones_seek_changed) {
                        const seekUpdate = data.zones_seek_changed.find(
                            (z: any) => z.zone_id === zone?.zone_id,
                        );
                        if (seekUpdate && zone?.now_playing) {
                            zone.now_playing.seek_position = seekUpdate.seek_position;
                            callbacks.onSeekChanged(seekUpdate.seek_position * 1_000_000);

                            // Roon doesn't send zones_changed when resuming a
                            // paused track — only seek updates start arriving.
                            // If we got a seek update WITHOUT zones_changed in
                            // the same event, the zone must have resumed.
                            if (!data.zones_changed && zone.state !== "playing") {
                                zone.state = "playing";
                                emitZoneChanged(zone);
                            }
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
            resetQueue();
            callbacks.onCoreUnpaired(core);
            console.log(`Core unpaired: ${core.display_name}`);

            // Reset the scan counter so periodic_scan sends SOOD queries every
            // 10s instead of every 60s (the library throttles after scan_count >= 6).
            roon.scan_count = -1;
        },
        moo_onerror: (moo: any) => {
            console.error(
                `Roon API connection error (${moo?.transport?.host}:${moo?.transport?.port})`,
            );
        },
    });

    roon.init_services({ required_services: [RoonApiBrowse, RoonApiImage, RoonApiTransport] });
    roon.start_discovery();
}

export interface RoonAction {
    title: string;
    command?: string; // socket command to use (defaults to "play")
}

export interface SearchResult {
    title: string;
    subtitle: string;
    item_key: string;
    image: string | null;
    image_key: string;
    hint: string;
    sessionKey: string;
    type: ItemType;
    category_key: string;
    index: number;
    actions: RoonAction[];
}

type ItemType = "track" | "album" | "artist" | "composer" | "playlist" | "work";

// Generic promisify for Roon API callbacks
function promisify<T>(
    fn: (opts: any, cb: (error: any, result: T) => void) => void,
    opts: any,
): Promise<T> {
    return new Promise((resolve, reject) => {
        fn(opts, (error, result) => {
            if (error) reject(error);
            else resolve(result);
        });
    });
}

// Parse Roon's special formatting in subtitles
function parseRoonSubtitle(subtitle: string): string {
    if (!subtitle) return "";
    // Remove Roon's wiki-link style formatting: [[id|name]] -> name
    return subtitle.replace(/\[\[(\d+)\|([^\]]+)]]/g, "$2").trim();
}

// Known actions for each item type based on Roon's behavior
export function getKnownActions(type: string, hint: string): RoonAction[] {
    const albumActions: RoonAction[] = [
        { title: "Play Now" },
        { title: "Add Next" },
        { title: "Queue" },
        { title: "Start Radio" },
    ];
    const trackActions: RoonAction[] = [
        { title: "Play Now" },
        { title: "Add Next" },
        { title: "Queue" },
        { title: "Play Album" },
        { title: "Start Radio" },
    ];
    const artistActions: RoonAction[] = [{ title: "Shuffle" }, { title: "Start Radio" }];

    if (hint === "action_list") {
        return type === "track" ? trackActions : artistActions;
    }

    switch (type) {
        case "album":
            return albumActions;
        case "track":
            return trackActions;
        case "artist":
        case "composer":
            return artistActions;
        case "playlist":
            return [
                { title: "Play Now" },
                { title: "Shuffle" },
                { title: "Add Next" },
                { title: "Queue" },
                { title: "Start Radio" },
            ];
        default:
            return [];
    }
}

// Infer item type from category title
function inferTypeFromCategory(categoryTitle: string): ItemType {
    const titleLower = categoryTitle.toLowerCase();
    const knownTypes: ItemType[] = ["artist", "album", "composer", "playlist", "track", "work"];
    return knownTypes.find((t) => titleLower.includes(t)) || "track";
}

export async function searchRoon(query: string): Promise<SearchResult[]> {
    if (!coreInstance) throw new Error("Roon Core not connected");
    if (!zone) throw new Error("No active zone");

    const browse = coreInstance.services.RoonApiBrowse;
    const sessionKey = `search_${Date.now()}`;
    const maxResultsPerCategory = 5;

    const browseOpts = (extra: object = {}) => ({
        hierarchy: "search",
        multi_session_key: sessionKey,
        zone_or_output_id: zone.zone_id,
        ...extra,
    });

    const result = await promisify<any>(browse.browse.bind(browse), browseOpts({ input: query }));
    const loadResult = await promisify<any>(
        browse.load.bind(browse),
        browseOpts({ input: query, offset: 0, count: result.list.count }),
    );

    // Load all categories
    const categoryData: Array<{
        category: any;
        items: any[];
        cachedImages: Map<string, string | null>;
        isArtistCategory: boolean;
    }> = [];

    for (const category of loadResult.items) {
        if (!category.title) continue;

        const categoryOpts = browseOpts({ item_key: category.item_key });
        const browseResult = await promisify<any>(browse.browse.bind(browse), categoryOpts);
        const itemsResult = await promisify<any>(browse.load.bind(browse), {
            ...categoryOpts,
            offset: 0,
            count: Math.min(browseResult.list.count, maxResultsPerCategory),
        });

        const imageKeys =
            itemsResult.items?.map((item: any) => item.image_key).filter(Boolean) || [];
        const cachedImages = await cacheImages(coreInstance.services.RoonApiImage, imageKeys);

        const categoryTitleLower = category.title.toLowerCase();
        const isArtistCategory =
            categoryTitleLower.includes("composer") || categoryTitleLower.includes("artist");

        categoryData.push({
            category,
            items: itemsResult.items || [],
            cachedImages,
            isArtistCategory,
        });
    }

    // First pass: collect artist images from artist/composer categories
    const artistImages = new Map<string, { path: string; key: string }>();
    for (const { items, cachedImages, isArtistCategory } of categoryData) {
        if (!isArtistCategory) continue;

        for (const item of items) {
            const imagePath = cachedImages.get(item.image_key);
            if (item.title && imagePath) {
                artistImages.set(item.title, { path: imagePath, key: item.image_key });
            }
        }
    }

    // Second pass: build results from non-artist categories
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    for (const { category, items, cachedImages, isArtistCategory } of categoryData) {
        if (isArtistCategory) continue;

        const baseType = inferTypeFromCategory(category.title);

        for (let index = 0; index < items.length; index++) {
            const item = items[index];
            if (item.title === "No Results") continue;
            const isPlayArtist = item.hint === "action_list" && item.title === "Play Artist";

            // Refine type: in mixed categories (e.g., "Top Results"), use hint to
            // distinguish albums (hint: "list") from tracks (hint: "action_list")
            let itemType: ItemType;
            if (isPlayArtist) {
                itemType = "artist";
            } else if (baseType === "track" && item.hint === "list") {
                itemType = "album";
            } else {
                itemType = baseType;
            }
            const actions = getKnownActions(itemType, item.hint);

            // Deduplicate: skip items with the same title + image_key (e.g., top-hit vs category)
            const dedupeKey = `${item.title}::${item.image_key}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);

            // For "Play Artist" items, use artist image from first pass if available
            const artistName = isPlayArtist ? category.title : null;
            const artistInfo = artistName ? artistImages.get(artistName) : null;
            const image = cachedImages.get(item.image_key) || artistInfo?.path || null;

            results.push({
                title: isPlayArtist
                    ? category.title
                    : item.title ||
                      `Unknown ${itemType.charAt(0).toUpperCase() + itemType.slice(1)}`,
                subtitle: parseRoonSubtitle(item.subtitle),
                item_key: item.item_key,
                image,
                image_key: item.image_key || artistInfo?.key || "",
                hint: item.hint,
                sessionKey,
                type: itemType,
                category_key: category.item_key,
                index,
                actions,
            });

            // For "Play Artist" items, only include the first entry
            if (isPlayArtist) break;
        }
    }

    const ranked = reRankResults(query, results);

    // Re-fetch missing images for injected frequency items
    const staleKeys = ranked
        .filter((r) => r.sessionKey === "stored" && !r.image && r.image_key)
        .map((r) => r.image_key);
    if (staleKeys.length > 0) {
        const refreshed = await cacheImages(coreInstance.services.RoonApiImage, staleKeys);
        for (const r of ranked) {
            if (r.sessionKey === "stored" && !r.image && r.image_key) {
                r.image = refreshed.get(r.image_key) || null;
            }
        }
    }

    return ranked;
}

export async function playItem(
    itemKey: string,
    sessionKey: string,
    categoryKey: string,
    itemIndex: number,
    actionTitle: string,
    itemTitle?: string,
    itemType?: string,
    itemImageKey?: string,
): Promise<void> {
    if (!coreInstance) throw new Error("Roon Core not connected");
    if (!zone) throw new Error("No active zone");

    const browse = coreInstance.services.RoonApiBrowse;

    const browseOpts = (sessionKey: string, extra: object = {}) => ({
        hierarchy: "search",
        multi_session_key: sessionKey,
        zone_or_output_id: zone.zone_id,
        ...extra,
    });

    // Handle injected items (from frequency store) — do a fresh search to resolve them
    if (sessionKey === "stored" && itemTitle) {
        console.log(`[DEBUG] Resolving stored item: "${itemTitle}" (image_key: ${itemImageKey})`);
        const freshResults = await searchRoon(itemTitle);
        const match = freshResults.find(
            (r) => r.image_key === itemImageKey && r.sessionKey !== "stored",
        );
        if (!match) {
            throw new Error(`Could not find "${itemTitle}" in fresh search results`);
        }
        return playItem(
            match.item_key,
            match.sessionKey,
            match.category_key,
            match.index,
            actionTitle,
            match.title,
            match.type,
            match.image_key,
        );
    }

    console.log(
        `[DEBUG] playItem: itemKey=${itemKey}, categoryKey=${categoryKey}, itemIndex=${itemIndex}, actionTitle=${actionTitle}`,
    );

    // Navigate to category
    await promisify<any>(
        browse.browse.bind(browse),
        browseOpts(sessionKey, { item_key: categoryKey }),
    );

    // Load the specific item
    const loadResult = await promisify<any>(
        browse.load.bind(browse),
        browseOpts(sessionKey, {
            item_key: categoryKey,
            offset: itemIndex,
            count: 1,
        }),
    );

    if (!loadResult.items?.[0]) {
        throw new Error("Item not found at index");
    }

    const actualItem = loadResult.items[0];
    const actualItemKey = actualItem.item_key;
    console.log(`[DEBUG] Got fresh item_key: ${actualItemKey}`);

    // "Play Album" is a synthetic action — Roon doesn't expose it in track browse hierarchy.
    // We need to find the album by searching for artist/band names from the subtitle.
    if (actionTitle === "Play Album") {
        const trackImageKey = actualItem.image_key;
        if (!trackImageKey) {
            throw new Error("Track has no image_key — cannot identify album");
        }

        const subtitle = actualItem.subtitle || "";
        // Parse comma-separated entries, prioritize single-word names (likely band names)
        const entries = subtitle
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean);
        const sorted = [...entries].sort((a, b) => a.split(/\s+/).length - b.split(/\s+/).length);

        const albumSessionKey = `album_${Date.now()}`;
        const albumBrowseOpts = (extra: object = {}) => ({
            hierarchy: "search",
            multi_session_key: albumSessionKey,
            zone_or_output_id: zone.zone_id,
            ...extra,
        });

        for (const candidate of sorted) {
            console.log(
                `[DEBUG] Trying album search with artist: "${candidate}" (track image_key: ${trackImageKey})`,
            );

            try {
                const searchResult = await promisify<any>(
                    browse.browse.bind(browse),
                    albumBrowseOpts({ input: candidate }),
                );
                const categories = await promisify<any>(
                    browse.load.bind(browse),
                    albumBrowseOpts({ offset: 0, count: searchResult.list.count }),
                );

                const albumsCategory = categories.items?.find(
                    (cat: any) => cat.title?.toLowerCase() === "albums",
                );
                if (!albumsCategory) continue;

                const albumsCatBrowse = await promisify<any>(
                    browse.browse.bind(browse),
                    albumBrowseOpts({ item_key: albumsCategory.item_key }),
                );
                const albums = await promisify<any>(
                    browse.load.bind(browse),
                    albumBrowseOpts({
                        offset: 0,
                        count: Math.min(albumsCatBrowse.list.count, 50),
                    }),
                );

                const matchingAlbum = albums.items?.find(
                    (album: any) => album.image_key === trackImageKey,
                );
                if (!matchingAlbum) continue;

                console.log(
                    `[DEBUG] Found matching album: "${matchingAlbum.title}" (via "${candidate}")`,
                );

                // Navigate into album → find list item → find "Play Album" action_list → "Play Now"
                await promisify<any>(
                    browse.browse.bind(browse),
                    albumBrowseOpts({ item_key: matchingAlbum.item_key }),
                );
                const l1Items = await promisify<any>(
                    browse.load.bind(browse),
                    albumBrowseOpts({ offset: 0, count: 5 }),
                );

                const albumListItem = l1Items.items?.find((i: any) => i.hint === "list");
                if (!albumListItem) continue;

                await promisify<any>(
                    browse.browse.bind(browse),
                    albumBrowseOpts({ item_key: albumListItem.item_key }),
                );
                const l2Items = await promisify<any>(
                    browse.load.bind(browse),
                    albumBrowseOpts({ offset: 0, count: 30 }),
                );

                const playAlbumAction = l2Items.items?.find(
                    (i: any) => i.hint === "action_list" && i.title === "Play Album",
                );
                if (!playAlbumAction) continue;

                await promisify<any>(
                    browse.browse.bind(browse),
                    albumBrowseOpts({ item_key: playAlbumAction.item_key }),
                );
                const l3Items = await promisify<any>(
                    browse.load.bind(browse),
                    albumBrowseOpts({ offset: 0, count: 10 }),
                );

                const playNow = l3Items.items?.find(
                    (i: any) => i.hint === "action" && i.title === "Play Now",
                );
                if (!playNow) continue;

                console.log(`[DEBUG] Playing album: "${matchingAlbum.title}"`);
                await promisify<any>(
                    browse.browse.bind(browse),
                    albumBrowseOpts({ item_key: playNow.item_key }),
                );
                console.log("[DEBUG] Successfully started album playback");
                recordPlay({
                    title: itemTitle || actualItem.title || "",
                    subtitle: parseRoonSubtitle(subtitle),
                    item_key: "",
                    image: null,
                    image_key: actualItem.image_key || itemImageKey || "",
                    hint: "",
                    sessionKey: "",
                    type: (itemType as any) || "track",
                    category_key: "",
                    index: 0,
                    actions: [],
                });
                return;
            } catch {}
        }

        throw new Error("Could not find album for this track");
    }

    // Navigate to the item to find actions
    async function findAndExecuteAction(
        currentItemKey: string,
        currentSessionKey: string,
        depth: number = 0,
    ): Promise<boolean> {
        if (depth > 5) return false;

        const browseResult = await promisify<any>(
            browse.browse.bind(browse),
            browseOpts(currentSessionKey, { item_key: currentItemKey }),
        );
        const newSessionKey = browseResult.list?.multi_session_key || currentSessionKey;

        const items = await promisify<any>(
            browse.load.bind(browse),
            browseOpts(newSessionKey, {
                item_key: currentItemKey,
                offset: 0,
                count: browseResult.list?.count || 50,
            }),
        );

        if (!items.items?.length) return false;

        for (const item of items.items) {
            console.log(`[DEBUG] Navigating: title=${item.title}, hint=${item.hint}`);

            if (item.hint === "action" && item.title === actionTitle) {
                console.log(`[DEBUG] Found action! Executing: ${item.title} (${item.item_key})`);
                await promisify<any>(
                    browse.browse.bind(browse),
                    browseOpts(newSessionKey, { item_key: item.item_key }),
                );
                console.log("[DEBUG] Successfully executed action");
                return true;
            }

            if (item.hint === "action_list" || (item.hint === "list" && items.items.length === 1)) {
                const found = await findAndExecuteAction(item.item_key, newSessionKey, depth + 1);
                if (found) return true;

                // For albums: stop after checking the first action_list
                if (depth === 1 && item.hint === "action_list") break;
            }
        }

        return false;
    }

    const found = await findAndExecuteAction(actualItemKey, sessionKey);
    if (!found) {
        throw new Error(`Could not find action "${actionTitle}" to execute`);
    }

    recordPlay({
        title: itemTitle || actualItem.title || "",
        subtitle: parseRoonSubtitle(actualItem.subtitle || ""),
        item_key: "",
        image: null,
        image_key: actualItem.image_key || itemImageKey || "",
        hint: "",
        sessionKey: "",
        type: (itemType as any) || "track",
        category_key: "",
        index: 0,
        actions: [],
    });
}

export function getZone() {
    return zone;
}

export function getCore() {
    return coreInstance;
}

export interface NowPlayingResponse {
    playing: boolean;
    state: "playing" | "paused" | "stopped" | "loading";
    title?: string;
    artist?: string;
    album?: string;
    image_key?: string;
    length_seconds?: number;
    seek_position_seconds?: number;
    zone_name?: string;
}

/**
 * Snapshot of the currently loaded track on the active zone.
 *
 * ``playing`` is true when a track is *loaded* — i.e. the user can meaningfully
 * say "what's on" — which includes the paused state. ``state`` carries the raw
 * Roon state for callers that need to distinguish playing vs. paused. When no
 * zone is paired or the zone is idle, returns ``{playing: false, state: "stopped"}``
 * with no metadata fields.
 */
export function getNowPlaying(): NowPlayingResponse {
    if (!zone || !zone.now_playing) {
        return { playing: false, state: "stopped" };
    }
    const np = zone.now_playing;
    const parsed = parseNowPlaying(np);
    const rawState: string = zone.state || "stopped";
    // Narrow to the documented set; anything unexpected from Roon becomes "stopped".
    const state: NowPlayingResponse["state"] =
        rawState === "playing" ||
        rawState === "paused" ||
        rawState === "stopped" ||
        rawState === "loading"
            ? rawState
            : "stopped";
    return {
        playing: state !== "stopped",
        state,
        title: parsed.title,
        artist: parsed.artists[0] || "",
        album: parsed.album,
        image_key: np.image_key || "",
        length_seconds: Math.round(np.length || 0),
        seek_position_seconds: Math.round(np.seek_position || 0),
        zone_name: zone.display_name || "",
    };
}

export interface QueueItem {
    queue_item_id: number;
    title: string;
    artist: string;
    album: string;
    image_key: string;
    length_seconds: number;
}

export interface QueueResponse {
    zone_name?: string;
    total_count: number;
    items: QueueItem[];
}

// Flatten a raw Roon queue item into the shape exposed over the API. Roon packs
// title/artist/album into ``three_line`` (with ``two_line``/``one_line`` as
// progressively sparser fallbacks) and, like now-playing, joins multiple
// artists with " / " — we keep the first to match parseNowPlaying.
function mapQueueItem(item: any): QueueItem {
    const rawArtist = item.three_line?.line2 || item.two_line?.line2 || "";
    return {
        queue_item_id: item.queue_item_id,
        title: item.three_line?.line1 || item.two_line?.line1 || item.one_line?.line1 || "",
        artist: rawArtist ? rawArtist.split(" / ")[0].trim() : "",
        album: item.three_line?.line3 || "",
        image_key: item.image_key || "",
        length_seconds: Math.round(item.length || 0),
    };
}

/**
 * Snapshot of the active zone's play queue. Returns the upcoming items in order
 * (the currently playing track is the first entry while it plays). When no zone
 * is paired or the queue is empty, ``items`` is ``[]`` and ``total_count`` is 0.
 */
export function getQueue(): QueueResponse {
    return {
        zone_name: zone?.display_name || "",
        total_count: queue.length,
        items: queue.map(mapQueueItem),
    };
}

/**
 * Jump playback to a specific queue item (Roon's ``play_from_here``). This is the
 * only queue mutation Roon's API exposes: it starts playing the given item, so
 * everything before it drops out of the upcoming queue. ``queueItemId`` is the
 * ``queue_item_id`` from a {@link getQueue} item.
 */
export function playFromQueue(queueItemId: number): void {
    if (!zone) throw new Error("No active zone");
    if (!Number.isFinite(queueItemId)) throw new Error("Invalid queue_item_id");
    const transport = coreInstance?.services?.RoonApiTransport;
    if (!transport) throw new Error("No transport service");
    // Roon's play_from_here performs the jump but never sends a completion ack,
    // so success can't be read from its callback. Validate the id against the
    // cached queue instead (deterministic, and rejects stale IDs), then fire.
    if (!queue.some((item) => item.queue_item_id === queueItemId)) {
        throw new Error("queue_item_id not in current queue");
    }
    transport.play_from_here(zone, queueItemId);
}
