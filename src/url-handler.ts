import net from "node:net";

const SOCKET_PATH = "/tmp/roonpipe.sock";

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

export async function handleTidalUrl(url: string): Promise<void> {
    const match = url.match(/^tidal:\/\/(\w+)\/([^/?#]+)/i);
    if (!match) {
        console.error(`❌ Unsupported Tidal URL: ${url}`);
        process.exit(1);
    }

    const [, kind, id] = match;
    if (kind.toLowerCase() !== "track") {
        console.error(`❌ Only Tidal track URLs are supported, got: ${kind}`);
        process.exit(1);
    }

    console.log(`🎵 Playing Tidal track ${id}...`);
    try {
        const response = await sendCommand({ command: "play_tidal_track", track_id: id });
        if (response.title) {
            console.log(
                `✅ Now playing: ${response.title}${response.artist ? ` · ${response.artist}` : ""}`,
            );
        } else {
            console.log("✅ Success!");
        }
        process.exit(0);
    } catch (error) {
        console.error("❌ Failed:", error);
        process.exit(1);
    }
}
