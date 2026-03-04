import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getImageCachePath, isImageCached } from "./image-cache";
import type { SearchResult } from "./roon";

type ItemType = "track" | "album" | "artist" | "composer" | "playlist" | "work";

interface StoredItem {
    title: string;
    subtitle: string;
    type: ItemType;
    image: string | null;
    image_key: string;
    count: number;
    lastPlayed: number;
}

interface FrequencyData {
    version: 1;
    items: Record<string, StoredItem>;
}

const FREQUENCY_PATH = path.join(os.homedir(), ".cache", "roonpipe", "frequency.json");
const MAX_AGE_DAYS = 180;

let data: FrequencyData = { version: 1, items: {} };
let saveTimeout: NodeJS.Timeout | null = null;

function makeKey(type: string, title: string, imageKey: string): string {
    return `${type}::${title}::${imageKey}`;
}

function saveToDisk(): void {
    try {
        const dir = path.dirname(FREQUENCY_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(FREQUENCY_PATH, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error("Failed to save frequency data:", e);
    }
}

function debouncedSave(): void {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveToDisk, 2000);
}

function pruneOldEntries(): void {
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (const [key, item] of Object.entries(data.items)) {
        if (item.lastPlayed < cutoff) {
            delete data.items[key];
        }
    }
}

export function loadFrequencyData(): void {
    try {
        if (fs.existsSync(FREQUENCY_PATH)) {
            const raw = JSON.parse(fs.readFileSync(FREQUENCY_PATH, "utf-8"));
            if (raw?.version === 1 && raw?.items) {
                data = raw;
                pruneOldEntries();
                saveToDisk();
            }
        }
    } catch (e) {
        console.error("Failed to load frequency data, starting fresh:", e);
        data = { version: 1, items: {} };
    }
}

export function recordPlay(result: SearchResult): void {
    try {
        const key = makeKey(result.type, result.title, result.image_key);
        const existing = data.items[key];
        data.items[key] = {
            title: result.title,
            subtitle: result.subtitle,
            type: result.type,
            image: result.image,
            image_key: result.image_key,
            count: (existing?.count || 0) + 1,
            lastPlayed: Date.now(),
        };
        debouncedSave();
    } catch (e) {
        console.error("Failed to record play:", e);
    }
}

function computeScore(item: StoredItem): number {
    const daysSinceLastPlay = (Date.now() - item.lastPlayed) / (24 * 60 * 60 * 1000);
    return Math.log2(1 + item.count) * 0.5 ** (daysSinceLastPlay / 30);
}

export function reRankResults(query: string, results: SearchResult[]): SearchResult[] {
    try {
        const queryLower = query.toLowerCase();

        // Build set of existing result dedupe keys
        const existingKeys = new Set(results.map((r) => `${r.title}::${r.image_key}`));

        // Find stored items matching the query that aren't already in results
        const injected: SearchResult[] = [];
        for (const [, item] of Object.entries(data.items)) {
            if (!item.title.toLowerCase().includes(queryLower)) continue;

            const dedupeKey = `${item.title}::${item.image_key}`;
            if (existingKeys.has(dedupeKey)) continue;

            const image =
                item.image_key && isImageCached(item.image_key)
                    ? getImageCachePath(item.image_key)
                    : item.image;

            injected.push({
                title: item.title,
                subtitle: item.subtitle,
                item_key: "",
                image,
                image_key: item.image_key,
                hint: "",
                sessionKey: "stored",
                type: item.type,
                category_key: "",
                index: 0,
                actions:
                    item.type === "track"
                        ? [
                              { title: "Play Now" },
                              { title: "Add Next" },
                              { title: "Queue" },
                              { title: "Play Album" },
                              { title: "Start Radio" },
                          ]
                        : item.type === "album"
                          ? [
                                { title: "Play Now" },
                                { title: "Add Next" },
                                { title: "Queue" },
                                { title: "Start Radio" },
                            ]
                          : item.type === "artist" || item.type === "composer"
                            ? [{ title: "Shuffle" }, { title: "Start Radio" }]
                            : [],
            });
        }

        // Build frequency score map
        const scoreMap = new Map<string, number>();
        for (const [, item] of Object.entries(data.items)) {
            const dedupeKey = `${item.title}::${item.image_key}`;
            scoreMap.set(dedupeKey, computeScore(item));
        }

        const merged = [...results, ...injected];
        const totalCount = merged.length;

        merged.sort((a, b) => {
            const aKey = `${a.title}::${a.image_key}`;
            const bKey = `${b.title}::${b.image_key}`;
            const aFreq = scoreMap.get(aKey) || 0;
            const bFreq = scoreMap.get(bKey) || 0;

            const aIdx = results.indexOf(a);
            const bIdx = results.indexOf(b);

            // Original position score (scaled down so a single play outranks any position)
            const aPos = aIdx >= 0 ? 0.5 * (1 - aIdx / totalCount) : 0;
            const bPos = bIdx >= 0 ? 0.5 * (1 - bIdx / totalCount) : 0;

            const aScore = aPos + aFreq;
            const bScore = bPos + bFreq;

            return bScore - aScore;
        });

        return merged;
    } catch (e) {
        console.error("Failed to re-rank results:", e);
        return results;
    }
}
