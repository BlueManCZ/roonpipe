import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join as pathJoin } from "node:path";

import { startCLI } from "./cli";
import { loadFrequencyData } from "./frequency";
import { initGnomeSearchProvider } from "./gnome-search-provider";
import { clearOldCache } from "./image-cache";
import { initMpris, updateMprisMetadata, updateMprisSeek } from "./mpris";
import { showTrackNotification } from "./notification";
import { getCore, getNowPlaying, getZone, initRoon, playItem, searchRoon } from "./roon";
import { isInstanceRunning, startSocketServer, startTcpServer } from "./socket";
import { playTidalTrack } from "./tidal";
import { handleTidalUrl } from "./url-handler";

const installGnome = process.argv.includes("--install-gnome");
const cliMode = process.argv.includes("--cli");
const tidalUrl = process.argv.find((arg) => arg.startsWith("tidal://"));

function isRunningOnGnome(): boolean {
    return (
        (process.env.XDG_CURRENT_DESKTOP?.includes("GNOME") ?? false) ||
        (process.env.DESKTOP_SESSION?.includes("gnome") ?? false)
    );
}

// Read the value of a `--flag value` or `--flag=value` CLI argument.
function getArgValue(flag: string): string | undefined {
    const idx = process.argv.indexOf(flag);
    if (idx !== -1 && idx + 1 < process.argv.length) {
        return process.argv[idx + 1];
    }
    const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`));
    return inline ? inline.slice(flag.length + 1) : undefined;
}

// Parse a `--listen` value of the form `<port>` or `<host:port>`. Defaults the
// host to 0.0.0.0 (all interfaces) — the mandatory token is what guards access.
function parseListenAddr(addr: string): { host: string; port: number } | null {
    const lastColon = addr.lastIndexOf(":");
    const host = lastColon === -1 ? "0.0.0.0" : addr.slice(0, lastColon) || "0.0.0.0";
    const portStr = lastColon === -1 ? addr : addr.slice(lastColon + 1);
    const port = Number.parseInt(portStr, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { host, port };
}

function isGnomeSearchProviderInstalled(): boolean {
    return existsSync(
        "/usr/share/gnome-shell/search-providers/com.bluemancz.RoonPipe.SearchProvider.ini",
    );
}

if (installGnome) {
    const scriptPath = pathJoin(__dirname, "../scripts/install-gnome-search-provider.sh");
    if (process.getuid && process.getuid() !== 0) {
        console.log(
            "To install GNOME Search Provider, you need to run this command as root or with sudo:",
        );
        console.log(`sudo bash "${scriptPath}"`);
        process.exit(1);
    } else {
        console.log("Installing GNOME Search Provider...");
        execSync(`bash "${scriptPath}"`, { stdio: "inherit" });
        process.exit(0);
    }
}

if (tidalUrl) {
    // URL handler mode — forward to running daemon and exit
    handleTidalUrl(tidalUrl);
} else if (cliMode) {
    // CLI mode - just connect to daemon via socket
    startCLI();
} else {
    // Daemon mode - check for the existing instance
    if (process.getuid && process.getuid() === 0) {
        console.error("❌ Running as root. Please run as a regular user for the daemon.");
        process.exit(1);
    }

    // Optional network (TCP) API. Fails closed: --listen without a token exits,
    // so the control surface is never exposed on the network unauthenticated.
    const listenAddr = getArgValue("--listen");
    let tcpConfig: { host: string; port: number; token: string } | null = null;
    if (listenAddr) {
        const parsed = parseListenAddr(listenAddr);
        if (!parsed) {
            console.error(
                `❌ Invalid --listen value: "${listenAddr}". Expected <port> or <host:port>.`,
            );
            process.exit(1);
        }
        const token = process.env.ROONPIPE_TOKEN;
        if (!token) {
            console.error(
                "❌ --listen requires a shared secret. Set ROONPIPE_TOKEN to enable the network API.",
            );
            process.exit(1);
        }
        tcpConfig = { host: parsed.host, port: parsed.port, token };
    }

    isInstanceRunning().then((running) => {
        if (running) {
            console.error("❌ Another instance of RoonPipe is already running.");
            console.error("  Stop the existing instance first, or use --cli to connect to it.");
            process.exit(1);
        }

        // Daemon mode - start all services
        console.log("Starting RoonPipe Daemon");
        clearOldCache();
        loadFrequencyData();

        // Check if GNOME Search Provider is installed
        if (isRunningOnGnome()) {
            const installed = isGnomeSearchProviderInstalled();
            if (!installed) {
                console.warn("⚠️ GNOME Search Provider not installed.");
                console.warn(
                    "  Run 'roonpipe --install-gnome' to enable searching from GNOME overview.",
                );
            }
        }

        // Initialize MPRIS
        initMpris(() => getCore()?.services.RoonApiTransport, getZone);

        // Initialize Roon and start socket server
        initRoon({
            onCorePaired: (_core: any) => {
                const handlers = {
                    search: searchRoon,
                    play: playItem,
                    playTidalTrack,
                    nowPlaying: getNowPlaying,
                };
                startSocketServer(handlers);

                // Expose the same handlers over the network if configured.
                if (tcpConfig) {
                    startTcpServer(handlers, tcpConfig.host, tcpConfig.port, tcpConfig.token);
                }

                // Initialize GNOME-Shell Search Provider only on GNOME
                if (isRunningOnGnome()) {
                    initGnomeSearchProvider(searchRoon, playItem);
                }
            },
            onCoreUnpaired: (_core: any) => {
                // Clear MPRIS metadata when unpaired
                updateMprisMetadata(null, null);
            },
            onZoneChanged: (zone: any, core: any) => {
                // Update MPRIS when zone changes
                updateMprisMetadata(zone, core);
                // Show desktop notification
                showTrackNotification(zone, core);
            },
            onSeekChanged: (seekPosition: number) => {
                // Update MPRIS seek position
                updateMprisSeek(seekPosition);
            },
        });
    });
}
