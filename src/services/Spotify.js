import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

export async function getSpotifyAccessToken() {
    const authString = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${authString}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });

    const data = await response.json();
    return data.access_token;
}

export async function fetchTopTracks({ spotifyID, market = 'US', accessToken = '' }) {
    if (!spotifyID) {
        throw new Error(`Invalid artistId: ${ spotifyID }`);
    }

    if (!accessToken || accessToken === '') {
        accessToken = await getSpotifyAccessToken();
    }

    const url = `https://api.spotify.com/v1/artists/${spotifyID}/top-tracks?market=${market}`;

    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!response.ok) {
        console.error(response);
        const errorText = await response.text();
        console.error(`[Spotify] Failed to fetch top tracks: ${response.status}`);
        console.error("[Spotify] Response body:", errorText);
        throw new Error("Failed to fetch top tracks from Spotify");
    }

    const data = await response.json();

    if (!data?.tracks) return [];

    return data.tracks.map(track => ({
        name: track.name,
        preview_url: track.preview_url,
        popularity: track.popularity,
        spotifyUrl: track.external_urls?.spotify,
        album: {
            name: track.album.name,
            imageUrl: track.album.images?.[0]?.url,
            release_date: track.album.release_date
        }
    }));
}


export async function fetchRecentReleases({ spotifyID, market = 'US', limit = 10, accessToken }) {
    if (!spotifyID) {
        throw new Error(`Invalid artistId: ${ spotifyID }`);
    }

    if (!accessToken || accessToken === '') {
        accessToken = await getSpotifyAccessToken();
    }

    const url = `https://api.spotify.com/v1/artists/${spotifyID}/albums?include_groups=album,single&market=${market}&limit=20`;

    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!response.ok) {
        console.error(response);
        const errorText = await response.text();
        console.error(`[Spotify] Failed to fetch top tracks: ${response.status}`);
        console.error("[Spotify] Response body:", errorText);
        throw new Error("Failed to fetch top tracks from Spotify");
    }

    const data = await response.json();
    if (!data.items) return [];

    // Deduplicate by album name and sort by release date (descending)
    const seen = new Set();
    const sorted = data.items
        .filter(album => {
            if (seen.has(album.name.toLowerCase())) return false;
            seen.add(album.name.toLowerCase());
            return true;
        })
        .sort((a, b) => new Date(b.release_date) - new Date(a.release_date))
        .slice(0, limit);

    return sorted.map(album => ({
        name: album.name,
        id: album.id,
        spotifyUrl: album.external_urls?.spotify,
        release_date: album.release_date,
        type: album.album_type,
        imageUrl: album.images?.[0]?.url || null
    }));
}

export async function fetchTopSpotifyIdsForUser(accessToken) {
    let offset = 0;
    const limit = 50;
    const ids = new Set();
    const term_range = "long_term"; // "short_term", "medium_term", "long_term"

    while (true) {
        const res = await fetch(`https://api.spotify.com/v1/me/top/artists?time_range=${term_range}&limit=${limit}&offset=${offset}`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`Spotify fetch failed: ${errorText}`);
        }

        const json = await res.json();
        const items = json.items || [];
        items.forEach(artist => ids.add(artist.id));

        if (items.length < limit) break;
        offset += limit;
    }
    return Array.from(ids);
}

export async function getAccessTokenFromRefresh(refreshToken) {
    console.log("[TOKEN] Attempting to refresh access token with:", refreshToken);

    const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: process.env.SPOTIFY_CLIENT_ID
        })
    });

    const data = await res.json();

    if (!res.ok) {
        console.error("[TOKEN] Refresh failed:", data);
        throw new Error(`Failed to refresh access token: ${JSON.stringify(data)}`);
    }

    console.log("[TOKEN] Received access token:", data.access_token);
    if (data.refresh_token) {
        console.log("[TOKEN] Received NEW refresh token:", data.refresh_token);
    } else {
        console.log("[TOKEN] No new refresh token received, keeping existing one.");
    }

    return {
        access_token: data.access_token,
        new_refresh_token: data.refresh_token || null
    };
}

export async function fetchTopSpotifyTrackIds(accessToken) {
    const limit = 1000;
    let offset = 0;
    const trackIdSet = new Set();

    while (true) {
        const res = await fetch(`https://api.spotify.com/v1/me/top/tracks?limit=${limit}&offset=${offset}&time_range=long_term`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Failed to fetch top tracks: ${res.status} - ${errText}`);
        }

        const json = await res.json();
        const items = json.items || [];

        items.forEach(track => trackIdSet.add(track.id));

        if (items.length < limit) break;
        offset += limit;
    }

    return Array.from(trackIdSet);
}
