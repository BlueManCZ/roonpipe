// @ts-nocheck
import dbus from "dbus-next";

import type { PlayAction } from "./roon";

const OBJECT_PATH = "/com/bluemancz/RoonPipe/SearchProvider";
const BUS_NAME = "com.bluemancz.RoonPipe.SearchProvider";

// Store search results for later retrieval
const searchResultsCache = new Map<string, any>();

// Cache for query results to avoid repeated API calls
const queryCache = new Map<string, string[]>();

// Debounce variables
let debounceTimeout: NodeJS.Timeout | null = null;
let currentQuery = "";
let currentPromise: Promise<string[]> | null = null;

let searchFn: ((query: string) => Promise<any[]>) | null = null;
let playFn: ((itemKey: string, sessionKey: string, action: string) => Promise<void>) | null = null;

async function doSearch(terms: string[]): Promise<string[]> {
    console.log("Searching for terms:", terms);
    if (!searchFn) {
        return [];
    }

    const query = terms.join(" ");
    if (query.length < 4) {
        return [];
    }

    // If same query, return current promise
    if (query === currentQuery && currentPromise) {
        return currentPromise;
    }

    // Cancel previous debounce
    if (debounceTimeout) {
        clearTimeout(debounceTimeout);
    }

    currentQuery = query;

    currentPromise = new Promise((resolve) => {
        debounceTimeout = setTimeout(async () => {
            // Check if still the current query
            if (query !== currentQuery) {
                resolve([]);
                return;
            }

            // Check cache
            if (queryCache.has(query)) {
                resolve(queryCache.get(query));
                return;
            }

            try {
                console.log("Searching for terms:", terms);
                const results = await searchFn(query);

                // Store new results (don't clear to keep old ones for clicks)
                // searchResultsCache.clear();

                const ids: string[] = [];
                for (const result of results.slice(0, 5)) {
                    const id = `roon_${result.item_key}`;
                    searchResultsCache.set(id, result);
                    ids.push(id);
                }

                // Cache the ids for this query
                queryCache.set(query, ids);

                resolve(ids);
            } catch (error) {
                console.error("Search failed:", error);
                resolve([]);
            }
        }, 300);
    });

    return currentPromise;
}

// Define the D-Bus interface
const { Interface } = dbus.interface;

class RoonSearchProvider extends Interface {
    constructor() {
        super("org.gnome.Shell.SearchProvider2");
    }

    async GetInitialResultSet(terms) {
        return doSearch(terms);
    }

    async GetSubsearchResultSet(_previousResults, terms) {
        return doSearch(terms);
    }

    async GetResultMetas(identifiers) {
        const Variant = dbus.Variant;
        const metas = [];

        for (const id of identifiers) {
            const result = searchResultsCache.get(id);
            if (result) {
                const meta = {
                    id: new Variant("s", id),
                    name: new Variant("s", result.title),
                    description: new Variant("s", result.subtitle),
                };

                if (result.image) {
                    meta.gicon = new Variant("s", result.image);
                }

                metas.push(meta);
            }
        }

        return metas;
    }

    async ActivateResult(identifier, _terms, _timestamp) {
        console.log("ActivateResult called for:", identifier);
        const result = searchResultsCache.get(identifier);
        console.log("Result to activate:", result);
        if (result && playFn) {
            try {
                await playFn(result.item_key, result.sessionKey, "playNow");
                console.log(`Playing: ${result.title}`);
            } catch (error) {
                console.error("Failed to play track:", error);
            }
        }
    }

    async LaunchSearch(_terms, _timestamp) {
        console.log("LaunchSearch called - not implemented");
    }
}

// Define method signatures
RoonSearchProvider.configureMembers({
    methods: {
        GetInitialResultSet: { inSignature: "as", outSignature: "as" },
        GetSubsearchResultSet: { inSignature: "asas", outSignature: "as" },
        GetResultMetas: { inSignature: "as", outSignature: "aa{sv}" },
        ActivateResult: { inSignature: "sasu", outSignature: "" },
        LaunchSearch: { inSignature: "asu", outSignature: "" },
    },
});

export async function initGnomeSearchProvider(
    search: (query: string) => Promise<any[]>,
    play: (itemKey: string, sessionKey: string, action?: PlayAction) => Promise<void>,
) {
    searchFn = search;
    playFn = play;

    try {
        const bus = dbus.sessionBus();

        // Request the bus name
        await bus.requestName(BUS_NAME, 0);

        // Create and export the search provider interface
        const provider = new RoonSearchProvider();
        bus.export(OBJECT_PATH, provider);

        console.log("GNOME Search Provider initialized on", BUS_NAME);
    } catch (error) {
        console.error("Failed to initialize GNOME Search Provider:", error);
    }
}
