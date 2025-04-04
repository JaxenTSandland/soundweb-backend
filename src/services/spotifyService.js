import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const MAX_ARTIST_LOOKUP = 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function getSpotifyAccessToken() {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
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

async function searchSpotifyArtist(artistName, accessToken) {
    const query = encodeURIComponent(artistName);
    const url = `https://api.spotify.com/v1/search?q=${query}&type=artist&limit=1`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    });

    const data = await response.json();
    return data.artists.items[0]; // return top result
}

export async function fetchAndSaveSpotifyArtists() {
    try {
        const accessToken = await getSpotifyAccessToken();
        const lastfmPath = path.join(__dirname, '../data/lastfmArtists.json');
        const spotifyPath = path.join(__dirname, '../data/spotifyArtists.json');

        const lastfmData = JSON.parse(fs.readFileSync(lastfmPath, 'utf-8'));

        const results = [];
        var i = 1;
        for (const artist of lastfmData) {
            if (i > MAX_ARTIST_LOOKUP) break;

            const name = artist.name;
            const listeners = artist.listeners;
            console.log(`(${i++}/${MAX_ARTIST_LOOKUP}) Searching Spotify for: ${name}`);
            const spotifyArtist = await searchSpotifyArtist(name, accessToken);

            if (spotifyArtist) {
                results.push({
                    name: spotifyArtist.name,
                    spotifyId: spotifyArtist.id,
                    popularity: spotifyArtist.popularity,
                    genres: spotifyArtist.genres,
                    followers: spotifyArtist.followers.total,
                    listeners: listeners,
                    spotifyUrl: spotifyArtist.external_urls.spotify
                });
            } else {
                console.warn(`No match found for ${name}`);
            }
        }


        fs.writeFileSync(spotifyPath, JSON.stringify(results, null, 2), 'utf-8');
        console.log(`✅ Saved ${results.length} artists to spotifyArtists.json`);

    } catch (err) {
        console.error('❌ Error during Spotify artist fetch:', err);
    }
}