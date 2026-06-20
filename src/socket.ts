import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";

import { removeFrequencyEntry } from "./frequency";
import type { NowPlayingResponse, QueueResponse } from "./roon";

const SOCKET_PATH = "/tmp/roonpipe.sock";
let socketServer: net.Server | null = null;
let tcpServer: net.Server | null = null;

export interface SocketHandlers {
    search: (query: string) => Promise<any>;
    play: (
        itemKey: string,
        sessionKey: string,
        categoryKey: string,
        itemIndex: number,
        actionTitle: string,
        itemTitle?: string,
        itemType?: string,
        itemImageKey?: string,
    ) => Promise<any>;
    playTidalTrack: (trackId: string) => Promise<{ title: string; artist: string }>;
    nowPlaying: () => NowPlayingResponse;
    queue: () => QueueResponse;
    playFromQueue: (queueItemId: number) => void;
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

// Constant-time string comparison to avoid leaking the token via timing.
function tokenMatches(provided: string, expected: string): boolean {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * Dispatch a single parsed request and write the JSON response, then close the
 * connection. Shared by the local Unix socket and the network (TCP) listener.
 */
async function processRequest(
    request: any,
    client: net.Socket,
    handlers: SocketHandlers,
): Promise<void> {
    console.log("Received request:", request);

    if (request.command === "search") {
        try {
            const results = await handlers.search(request.query);
            client.write(`${JSON.stringify({ error: null, results })}\n`);
        } catch (error) {
            client.write(`${JSON.stringify({ error: String(error), results: null })}\n`);
        }
        client.end();
    } else if (request.command === "play") {
        try {
            await handlers.play(
                request.item_key,
                request.session_key,
                request.category_key,
                request.item_index,
                request.action_title,
                request.item_title,
                request.item_type,
                request.item_image_key,
            );
            client.write(`${JSON.stringify({ error: null, success: true })}\n`);
        } catch (error) {
            client.write(`${JSON.stringify({ error: String(error), success: false })}\n`);
        }
        client.end();
    } else if (request.command === "play_tidal_track") {
        try {
            const resolved = await handlers.playTidalTrack(request.track_id);
            client.write(`${JSON.stringify({ error: null, success: true, ...resolved })}\n`);
        } catch (error) {
            client.write(`${JSON.stringify({ error: String(error), success: false })}\n`);
        }
        client.end();
    } else if (request.command === "remove_frequency") {
        const removed = removeFrequencyEntry(
            request.item_type,
            request.item_title,
            request.item_image_key,
        );
        client.write(`${JSON.stringify({ error: null, success: removed })}\n`);
        client.end();
    } else if (request.command === "now_playing") {
        try {
            const snapshot = handlers.nowPlaying();
            client.write(`${JSON.stringify({ error: null, ...snapshot })}\n`);
        } catch (error) {
            client.write(
                `${JSON.stringify({
                    error: String(error),
                    playing: false,
                    state: "stopped",
                })}\n`,
            );
        }
        client.end();
    } else if (request.command === "queue") {
        try {
            const snapshot = handlers.queue();
            client.write(`${JSON.stringify({ error: null, ...snapshot })}\n`);
        } catch (error) {
            client.write(
                `${JSON.stringify({ error: String(error), total_count: 0, items: [] })}\n`,
            );
        }
        client.end();
    } else if (request.command === "play_from_queue") {
        try {
            await handlers.playFromQueue(Number(request.queue_item_id));
            client.write(`${JSON.stringify({ error: null, success: true })}\n`);
        } catch (error) {
            client.write(`${JSON.stringify({ error: String(error), success: false })}\n`);
        }
        client.end();
    } else {
        client.write(`${JSON.stringify({ error: "Unknown command" })}\n`);
        client.end();
    }
}

/**
 * Wire up a connected client. Buffers incoming data until a full JSON request
 * can be parsed (TCP may split a request across packets), then dispatches it.
 * When ``requireToken`` is set, the request must carry a matching ``token``
 * field or it is rejected before any handler runs.
 */
function handleConnection(
    client: net.Socket,
    handlers: SocketHandlers,
    requireToken: string | null,
) {
    let buffer = "";
    let handled = false;

    const tryHandle = async (final: boolean) => {
        if (handled) return;

        let request: any;
        try {
            request = JSON.parse(buffer);
        } catch {
            // Not a complete JSON object yet — wait for more data unless the
            // client already closed, in which case the payload was malformed.
            if (!final) return;
            handled = true;
            client.write(`${JSON.stringify({ error: "Invalid request format" })}\n`);
            client.end();
            return;
        }

        handled = true;

        if (requireToken) {
            const provided = typeof request.token === "string" ? request.token : "";
            if (!tokenMatches(provided, requireToken)) {
                client.write(`${JSON.stringify({ error: "Unauthorized" })}\n`);
                client.end();
                return;
            }
        }

        try {
            await processRequest(request, client, handlers);
        } catch (e) {
            console.error("Socket error:", e);
            try {
                client.write(`${JSON.stringify({ error: "Invalid request format" })}\n`);
            } catch {
                // Client may already be gone
            }
            client.end();
        }
    };

    client.on("data", (data) => {
        buffer += data.toString();
        void tryHandle(false);
    });

    client.on("end", () => void tryHandle(true));

    client.on("error", (err) => {
        console.error("Client error:", err);
    });
}

export function startSocketServer(handlers: SocketHandlers) {
    // Close old server if it exists (e.g., after core reconnection)
    if (socketServer) {
        try {
            socketServer.close();
        } catch (_) {
            // Ignore close errors on stale server
        }
        socketServer = null;
    }

    // Remove old socket if exists
    if (fs.existsSync(SOCKET_PATH)) {
        fs.unlinkSync(SOCKET_PATH);
    }

    socketServer = net.createServer((client) => {
        console.log("Client connected to socket");
        handleConnection(client, handlers, null);
    });

    socketServer.on("error", (err) => {
        console.error("Socket server error:", err);
    });

    socketServer.listen(SOCKET_PATH, () => {
        console.log("Unix socket server listening on", SOCKET_PATH);
        // Set permissions so any user can connect
        fs.chmodSync(SOCKET_PATH, 0o666);
    });
}

/**
 * Start the network (TCP) API listener. Reuses the same JSON command protocol
 * as the Unix socket, but every request must include a matching ``token``.
 *
 * Idempotent: the listener binds once and survives Roon core reconnections, so
 * repeated calls (e.g. on every ``core_paired``) are no-ops once it is up.
 */
export function startTcpServer(
    handlers: SocketHandlers,
    host: string,
    port: number,
    token: string,
) {
    if (tcpServer) return;

    tcpServer = net.createServer((client) => {
        const remote = client.remoteAddress ?? "unknown";
        console.log(`Network client connected from ${remote}`);
        handleConnection(client, handlers, token);
    });

    tcpServer.on("error", (err) => {
        console.error("TCP server error:", err);
        tcpServer = null;
    });

    tcpServer.listen(port, host, () => {
        console.log(`Network API server listening on ${host}:${port}`);
    });
}
