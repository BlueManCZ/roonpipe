import fs from "node:fs";
import net from "node:net";

const SOCKET_PATH = "/tmp/roonpipe.sock";
let socketServer: net.Server | null = null;

export interface SocketHandlers {
    search: (query: string) => Promise<any>;
    play: (itemKey: string, sessionKey: string, categoryKey: string, itemIndex: number, actionTitle: string) => Promise<any>;
}

/**
 * Check if another instance is already running by trying to connect to the socket
 */
export function isInstanceRunning(): Promise<boolean> {
    return new Promise((resolve) => {
        if (!fs.existsSync(SOCKET_PATH)) {
            resolve(false);
            return;
        }

        const client = net.createConnection({ path: SOCKET_PATH }, () => {
            // Connection successful - another instance is running
            client.end();
            resolve(true);
        });

        client.on("error", () => {
            // Connection failed - socket is stale, no instance running
            resolve(false);
        });

        // Timeout after 1 second
        client.setTimeout(1000, () => {
            client.destroy();
            resolve(false);
        });
    });
}

export function startSocketServer(handlers: SocketHandlers) {
    // Remove old socket if exists
    if (fs.existsSync(SOCKET_PATH)) {
        fs.unlinkSync(SOCKET_PATH);
    }

    socketServer = net.createServer((client) => {
        console.log("Client connected to socket");

        client.on("data", async (data) => {
            try {
                const request = JSON.parse(data.toString());
                console.log("Received request:", request);

                if (request.command === "search") {
                    try {
                        const results = await handlers.search(request.query);
                        client.write(`${JSON.stringify({ error: null, results })}\n`);
                    } catch (error) {
                        client.write(
                            `${JSON.stringify({ error: String(error), results: null })}\n`,
                        );
                    }
                    client.end();
                } else if (request.command === "play") {
                    try {
                        await handlers.play(request.item_key, request.session_key, request.category_key, request.item_index, request.action_title);
                        client.write(`${JSON.stringify({ error: null, success: true })}\n`);
                    } catch (error) {
                        client.write(
                            `${JSON.stringify({ error: String(error), success: false })}\n`,
                        );
                    }
                    client.end();
                } else {
                    client.write(`${JSON.stringify({ error: "Unknown command" })}\n`);
                    client.end();
                }
            } catch (e) {
                console.error("Socket error:", e);
                client.write(`${JSON.stringify({ error: "Invalid request format" })}\n`);
                client.end();
            }
        });

        client.on("error", (err) => {
            console.error("Client error:", err);
        });
    });

    socketServer.listen(SOCKET_PATH, () => {
        console.log("Unix socket server listening on", SOCKET_PATH);
        // Set permissions so any user can connect
        fs.chmodSync(SOCKET_PATH, 0o666);
    });
}
