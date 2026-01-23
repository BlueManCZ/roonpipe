import dbus from "dbus-next";

const OBJECT_PATH = "/com/bluemancz/RoonPipe/SearchProvider";
const BUS_NAME = "com.bluemancz.RoonPipe.SearchProvider";

// Store search results for later retrieval
const searchResultsCache = new Map<string, any>();

// Cache for query results to avoid repeated API calls
const queryCache = new Map<string, string[]>();

let debounceTimeout: NodeJS.Timeout | null = null;
let searchFn: ((query: string) => Promise<any[]>) | null = null;
let playFn:
    | ((
          itemKey: string,
          sessionKey: string,
          categoryKey: string,
          itemIndex: number,
          actionTitle: string,
      ) => Promise<void>)
    | null = null;

function debounce<T extends any[]>(func: (...args: T) => void, delay: number) {
    return (...args: T) => {
        if (debounceTimeout) clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(() => func(...args), delay);
    };
}

const debouncedSearch = debounce(async (query: string, resolve: (value: string[]) => void) => {
    const cached = queryCache.get(query);
    if (cached) {
        resolve(cached);
        return;
    }

    try {
        if (!searchFn) {
            resolve([]);
            return;
        }
        const results = await searchFn(query);
        const ids: string[] = [];
        for (const result of results.slice(0, 5)) {
            const id = `roon_${result.item_key}`;
            searchResultsCache.set(id, result);
            ids.push(id);
        }
        queryCache.set(query, ids);
        resolve(ids);
    } catch (error) {
        console.error("Search failed:", error);
        resolve([]);
    }
}, 300);

async function doSearch(terms: string[]): Promise<string[]> {
    const query = terms.join(" ");
    if (query.length < 4 || !searchFn) return [];

    return new Promise((resolve) => {
        debouncedSearch(query, resolve);
    });
}

// Define the D-Bus interface
const { Interface } = dbus.interface;

class RoonSearchProvider extends Interface {
    constructor() {
        super("org.gnome.Shell.SearchProvider2");
    }

    async GetInitialResultSet(terms: string[]) {
        return doSearch(terms);
    }

    async GetSubsearchResultSet(_previousResults: string[], terms: string[]) {
        return doSearch(terms);
    }

    async GetResultMetas(identifiers: string[]) {
        const Variant = dbus.Variant;
        const metas: any[] = [];

        for (const id of identifiers) {
            const result = searchResultsCache.get(id);
            if (result) {
                const meta: any = {
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

    async ActivateResult(identifier: string, _terms: string[], _timestamp: number) {
        const result = searchResultsCache.get(identifier);
        if (result && playFn) {
            try {
                if (result.actions.length > 0) {
                    // Find "Play Now" action for tracks, or "Shuffle" for artists, or first action
                    const playAction =
                        result.actions.find((a: any) => a.title === "Play Now") ||
                        result.actions.find((a: any) => a.title === "Shuffle") ||
                        result.actions[0];
                    await playFn(
                        result.item_key,
                        result.sessionKey,
                        result.category_key,
                        result.index,
                        playAction.title,
                    );
                    console.log(`Playing: ${result.title}`);
                }
            } catch (error) {
                console.error("Failed to play track:", error);
            }
        }
    }

    async LaunchSearch(_terms: string[], _timestamp: number) {
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
    play: (
        itemKey: string,
        sessionKey: string,
        categoryKey: string,
        itemIndex: number,
        actionTitle: string,
    ) => Promise<void>,
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
