import net from "node:net";
import readline from "node:readline";
import { Separator, select } from "@inquirer/prompts";

interface RoonAction {
    title: string;
}

interface SearchResult {
    title: string;
    subtitle: string;
    item_key: string;
    sessionKey: string;
    type: "track" | "album" | "artist" | "composer" | "playlist" | "work";
    category_key: string;
    index: number;
    actions: RoonAction[];
}

const SOCKET_PATH = "/tmp/roonpipe.sock";

// Helper to send command to daemon via socket
function sendCommand(command: object): Promise<any> {
    return new Promise((resolve, reject) => {
        const client = net.createConnection(SOCKET_PATH, () => {
            client.write(JSON.stringify(command));
        });

        let data = "";
        client.on("data", (chunk) => {
            data += chunk.toString();
        });

        client.on("end", () => {
            try {
                const response = JSON.parse(data);
                if (response.error) reject(response.error);
                else resolve(response);
            } catch {
                reject("Failed to parse response");
            }
        });

        client.on("error", (err) => {
            reject(`Cannot connect to RoonPipe daemon. Is it running?\n${err.message}`);
        });
    });
}

async function searchQuery(): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        rl.question("🔍 Search: ", (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

async function search(): Promise<SearchResult[]> {
    const query = await searchQuery();
    if (!query.trim()) return [];

    console.log(`\nSearching for "${query}"...\n`);

    try {
        const response = await sendCommand({ command: "search", query });
        return response.results || [];
    } catch (error) {
        console.error("❌ Error:", error);
        return [];
    }
}

async function selectTrack(results: SearchResult[]): Promise<SearchResult | null> {
    const typeIcons: Record<string, string> = {
        track: "🎵",
        album: "💿",
        artist: "🎤",
        playlist: "📋",
        work: "🎼",
        composer: "👤",
    };
    const choices = [
        ...results.map((result, index) => ({
            name: `${typeIcons[result.type] || "•"} ${result.title} ${result.subtitle ? `· ${result.subtitle}` : ""}`,
            value: index,
        })),
        new Separator(),
        { name: "🔍 New search", value: -1 },
        { name: "❌ Quit", value: -2 },
    ];

    try {
        const selection = await select<number>({
            message: "Select an item to play:",
            choices,
            pageSize: 15,
            theme: { prefix: "" },
        });

        if (selection === -2) return null;
        if (selection === -1)
            return {
                item_key: "",
                sessionKey: "",
                title: "",
                subtitle: "__search__",
                type: "track",
                category_key: "",
                index: 0,
                actions: [],
            };
        return results[selection];
    } catch {
        // User pressed Ctrl+C
        return null;
    }
}

async function selectAction(availableActions: RoonAction[]): Promise<RoonAction | null> {
    try {
        const actionIcons: Record<string, string> = {
            "Play Now": "▶️",
            Play: "▶️",
            Shuffle: "🔀",
            Queue: "📋",
            "Add to Queue": "📋",
            "Add Next": "⏭️",
            "Play From Here": "⏭️",
            "Start Radio": "📻",
        };

        const choices = availableActions.map((action) => ({
            name: `${actionIcons[action.title] || "•"} ${action.title}`,
            value: action,
        }));

        const action = await select<RoonAction | "back">({
            message: "What do you want to do?",
            choices: [...choices, new Separator(), { name: "← Back", value: "back" }],
            theme: { prefix: "" },
        });

        return action === "back" ? null : action;
    } catch {
        return null;
    }
}

async function playTrack(track: SearchResult, action: RoonAction): Promise<void> {
    console.log(
        `\n${action.title}: ${track.title}${track.subtitle ? ` · ${track.subtitle}` : ""}\n`,
    );

    try {
        await sendCommand({
            command: "play",
            item_key: track.item_key,
            session_key: track.sessionKey,
            category_key: track.category_key,
            item_index: track.index,
            action_title: action.title,
        });
        console.log("✅  Success!\n");
    } catch (error) {
        console.error("❌  Failed:", error);
    }
}

export async function startCLI() {
    console.log("\n🎵 RoonPipe Interactive Search");
    console.log("==============================\n");

    while (true) {
        const results = await search();
        if (!results.length) {
            console.log("❌ No results found.\n");
            continue;
        }

        console.log(`Found ${results.length} result(s):\n`);

        const selected = await selectTrack(results);
        if (!selected) {
            console.log("\nGoodbye! 👋\n");
            break;
        }

        if (selected.subtitle === "__search__") continue;

        // Use actions from search result
        if (selected.actions.length === 0) {
            console.log("No actions available for this item.\n");
            continue;
        }

        const action = await selectAction(selected.actions);
        if (!action) continue;

        await playTrack(selected, action);
    }
}
