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
