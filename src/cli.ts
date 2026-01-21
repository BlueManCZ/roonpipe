import net from "node:net";
import readline from "node:readline";
import { Separator, select } from "@inquirer/prompts";

type PlayAction = "playNow" | "queue" | "addNext";

interface SearchResult {
    title: string;
    subtitle: string;
    item_key: string;
    sessionKey: string;
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
        rl.question("🔍 Search for a track: ", (answer) => {
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
    const choices = [
        ...results.map((result, index) => ({
            name: `${result.title} ${result.subtitle ? `· ${result.subtitle}` : ""}`,
            value: index,
        })),
        new Separator(),
        { name: "🔍 New search", value: -1 },
        { name: "❌ Quit", value: -2 },
    ];

    try {
        const selection = await select<number>({
            message: "Select a track to play:",
            choices,
            pageSize: 15,
            theme: { prefix: "" },
        });

        if (selection === -2) return null;
        if (selection === -1)
            return { item_key: "", sessionKey: "", title: "", subtitle: "__search__" };
        return results[selection];
    } catch {
        // User pressed Ctrl+C
        return null;
    }
}

async function selectAction(): Promise<PlayAction | null> {
    try {
        const action = await select<PlayAction | "back">({
            message: "What do you want to do?",
            choices: [
                { name: "▶️ Play now", value: "playNow" as PlayAction },
                { name: "📋 Add to queue", value: "queue" as PlayAction },
                { name: "⏭️ Play next", value: "addNext" as PlayAction },
                new Separator(),
                { name: "← Back", value: "back" },
            ],
            theme: { prefix: "" },
        });

        return action === "back" ? null : action;
    } catch {
        return null;
    }
}

async function playTrack(track: SearchResult, action: PlayAction): Promise<void> {
    const labels = {
        playNow: "▶️ Playing",
        queue: "📋 Added to queue",
        addNext: "⏭️ Playing next",
    };

    console.log(
        `\n${labels[action]}: ${track.title}${track.subtitle ? ` · ${track.subtitle}` : ""}\n`,
    );

    try {
        await sendCommand({
            command: "play",
            item_key: track.item_key,
            session_key: track.sessionKey,
            action,
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
            console.log("❌ No tracks found.\n");
            continue;
        }

        console.log(`Found ${results.length} track(s):\n`);

        const selected = await selectTrack(results);
        if (!selected) {
            console.log("\nGoodbye! 👋\n");
            break;
        }

        if (selected.subtitle === "__search__") continue;

        const action = await selectAction();
        if (!action) continue;

        await playTrack(selected, action);
    }
}
