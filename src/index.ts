import { startCLI } from "./cli";
import { initMpris, updateMprisMetadata, updateMprisSeek } from "./mpris";
import { getCore, getZone, initRoon, playItem, searchRoon } from "./roon";
import { isInstanceRunning, startSocketServer } from "./socket";

// Check if CLI mode is requested
const cliMode = process.argv.includes("--cli");

if (cliMode) {
    // CLI mode - just connect to daemon via socket
    startCLI();
} else {
    // Daemon mode - check for the existing instance
    isInstanceRunning().then((running) => {
        if (running) {
            console.error("❌  Another instance of RoonPipe is already running.");
            console.error("   Stop the existing instance first, or use --cli to connect to it.");
            process.exit(1);
        }

        // Daemon mode - start all services
        console.log("Starting RoonPipe Daemon");

        // Initialize MPRIS
        initMpris(() => getCore()?.services.RoonApiTransport, getZone);

        // Initialize Roon and start socket server
        initRoon({
            onCorePaired: (_core: any) => {
                startSocketServer({
                    search: searchRoon,
                    play: playItem,
                });
            },
            onCoreUnpaired: (_core: any) => {
                // Clear MPRIS metadata when unpaired
                updateMprisMetadata(null, null);
            },
            onZoneChanged: (zone: any, core: any) => {
                // Update MPRIS when zone changes
                updateMprisMetadata(zone, core);
            },
            onSeekChanged: (seekPosition: number) => {
                // Update MPRIS seek position
                updateMprisSeek(seekPosition);
            },
        });
    });
}
