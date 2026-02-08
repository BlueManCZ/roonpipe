import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CACHE_DIR = path.join(os.homedir(), ".cache", "roonpipe", "images");

/**
 * Get the local cache path for an image
 */
export function getImageCachePath(imageKey: string): string {
    return path.join(CACHE_DIR, `${imageKey}.jpg`);
}

/**
 * Check if an image is already cached
 */
export function isImageCached(imageKey: string): boolean {
    return fs.existsSync(getImageCachePath(imageKey));
}

/**
 * Download and cache an image from Roon Core
 */
export async function cacheImage(imageApi: any, imageKey: string): Promise<string | null> {
    if (!imageKey) {
        return null;
    }

    const cachePath = getImageCachePath(imageKey);

    // Return cached path if already exists
    if (isImageCached(imageKey)) {
        return cachePath;
    }

    return new Promise((resolve) => {
        imageApi.get_image(
            imageKey,
            { scale: "fit", width: 300, height: 300, format: "image/jpeg" },
            (error: any, _contentType: string, imageData: Buffer) => {
                if (error || !imageData) {
                    resolve(null);
                    return;
                }

                try {
                    fs.mkdirSync(CACHE_DIR, { recursive: true });
                    fs.writeFileSync(cachePath, imageData);
                    resolve(cachePath);
                } catch {
                    resolve(null);
                }
            },
        );
    });
}

/**
 * Cache multiple images in parallel
 */
export async function cacheImages(
    imageApi: any,
    imageKeys: string[],
): Promise<Map<string, string | null>> {
    const results = new Map<string, string | null>();
    const uniqueKeys = [...new Set(imageKeys.filter(Boolean))];

    await Promise.all(
        uniqueKeys.map(async (key) => {
            const path = await cacheImage(imageApi, key);
            results.set(key, path);
        }),
    );

    return results;
}

/**
 * Clear old cached images (older than specified days)
 */
export function clearOldCache(maxAgeDays: number = 30): void {
    try {
        const files = fs.readdirSync(CACHE_DIR);
        const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
        const now = Date.now();

        for (const file of files) {
            const filePath = path.join(CACHE_DIR, file);
            const stats = fs.statSync(filePath);

            if (now - stats.mtimeMs > maxAgeMs) {
                fs.unlinkSync(filePath);
            }
        }
    } catch {
        // Ignore errors during cleanup
    }
}
