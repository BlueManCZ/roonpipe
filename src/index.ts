import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join as pathJoin } from "node:path";

import { startCLI } from "./cli";
import { initGnomeSearchProvider } from "./gnome-search-provider";
import { clearOldCache } from "./image-cache";
import { initMpris, updateMprisMetadata, updateMprisSeek } from "./mpris";
import { showTrackNotification } from "./notification";
import { getCore, getZone, initRoon, playItem, searchRoon } from "./roon";
import { isInstanceRunning, startSocketServer } from "./socket";

const installGnome = process.argv.includes("--install-gnome");
const cliMode = process.argv.includes("--cli");

function isRunningOnGnome(): boolean {
    return (
        (process.env.XDG_CURRENT_DESKTOP?.includes("GNOME") ?? false) ||
        (process.env.DESKTOP_SESSION?.includes("gnome") ?? false)
    );
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

if (cliMode) {
    // CLI mode - just connect to daemon via socket
    startCLI();
} else {
    // Daemon mode - check for the existing instance
    if (process.getuid && process.getuid() === 0) {
        console.error("❌ Running as root. Please run as a regular user for the daemon.");
        process.exit(1);
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
                startSocketServer({
                    search: searchRoon,
                    play: playItem,
                });

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
