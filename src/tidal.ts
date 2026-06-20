import fs from "node:fs";

import { playItem, searchRoon } from "./roon";

interface TidalConfig {
    client_id: string;
    client_secret: string;
    country_code?: string;
}

interface CachedToken {
    access_token: string;
    expires_at: number;
}

let cachedToken: CachedToken | null = null;

function loadTidalConfig(): TidalConfig {
    let content: string;
    try {
        content = fs.readFileSync("config.json", { encoding: "utf8" });
    } catch {
        throw new Error("config.json not found — cannot resolve tidal:// URLs");
    }
    const tidal = JSON.parse(content).tidal;
    if (!tidal?.client_id || !tidal?.client_secret) {
        throw new Error(
            'Tidal API credentials missing. Add {"tidal": {"client_id": "...", "client_secret": "..."}} to config.json. Register an app at https://developer.tidal.com/',
        );
    }
    return tidal;
}

async function getAccessToken(config: TidalConfig): Promise<string> {
    if (cachedToken && cachedToken.expires_at > Date.now() + 30_000) {
        return cachedToken.access_token;
    }
    const creds = Buffer.from(`${config.client_id}:${config.client_secret}`).toString("base64");
    const response = await fetch("https://auth.tidal.com/v1/oauth2/token", {
        method: "POST",
        headers: {
            Authorization: `Basic ${creds}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
    });
    if (!response.ok) {
        throw new Error(`Tidal auth failed (${response.status}): ${await response.text()}`);
    }
    const data = (await response.json()) as { access_token: string; expires_in: number };
    cachedToken = {
        access_token: data.access_token,
        expires_at: Date.now() + data.expires_in * 1000,
    };
    return cachedToken.access_token;
}

interface TidalResource {
    type: string;
    id: string;
    attributes?: { title?: string; name?: string };
}

interface TidalTrackResponse {
    data: {
        type: "tracks";
        id: string;
        attributes: { title: string };
        relationships?: { artists?: { data?: Array<{ type: string; id: string }> } };
    };
    included?: TidalResource[];
}

async function resolveTidalTrack(trackId: string): Promise<{ title: string; artist: string }> {
    const config = loadTidalConfig();
    const token = await getAccessToken(config);
    const country = config.country_code || "US";
    const url = `https://openapi.tidal.com/v2/tracks/${encodeURIComponent(trackId)}?countryCode=${encodeURIComponent(country)}&include=artists`;
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            accept: "application/vnd.api+json",
        },
    });
    if (!response.ok) {
        throw new Error(`Tidal track lookup failed (${response.status}): ${await response.text()}`);
    }
    const data = (await response.json()) as TidalTrackResponse;
    const title = data.data?.attributes?.title;
    if (!title) {
        throw new Error("Tidal response missing track title");
    }
    const artistIds = data.data.relationships?.artists?.data?.map((d) => d.id) ?? [];
    const includedArtists = (data.included ?? []).filter((r) => r.type === "artists");
    let artist = "";
    for (const id of artistIds) {
        const found = includedArtists.find((a) => a.id === id);
        if (found?.attributes?.name) {
            artist = found.attributes.name;
            break;
        }
    }
    return { title, artist };
}

export async function playTidalTrack(trackId: string): Promise<{ title: string; artist: string }> {
    const { title, artist } = await resolveTidalTrack(trackId);
    const query = artist ? `${artist} ${title}` : title;
    console.log(`[Tidal] Resolved track ${trackId} → "${title}"${artist ? ` by ${artist}` : ""}`);

    const results = await searchRoon(query);
    const track = results.find((r) => r.type === "track");
    if (!track) {
        throw new Error(`No matching track found in Roon for "${query}"`);
    }
    await playItem(
        track.item_key,
        track.sessionKey,
        track.category_key,
        track.index,
        "Play Now",
        track.title,
        track.type,
        track.image_key,
    );
    return { title, artist };
}
