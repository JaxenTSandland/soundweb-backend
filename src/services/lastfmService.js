import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();
const MAX_ARTIST_LOOKUP = 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_KEY = process.env.LASTFM_API_KEY;
const BASE_URL = 'https://ws.audioscrobbler.com/2.0/';

function normalizeName(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

export async function fetchTopArtistsFromLastFM() {
    const allArtists = [];

    for (let page = 1; page <= 20; page++) {
        const url = `${BASE_URL}?method=chart.gettopartists&api_key=${API_KEY}&format=json&page=${page}`;
        const res = await fetch(url);
        const json = await res.json();
        const artists = json.artists?.artist ?? [];

        allArtists.push(...artists.map(({ name, mbid, url }) => ({
            name, mbid, url
        })));

        console.log(`Fetched page ${page} with ${artists.length} artists`);
    }

    const outputPath = path.join(__dirname, '../data/lastfmTopArtists.json');
    fs.writeFileSync(outputPath, JSON.stringify(allArtists, null, 2));
    console.log(`✅ Saved ${allArtists.length} artists to lastfmTopArtists.json`);
}

export async function fetchArtistDetailsFromLastFM() {
    const inputPath = path.join(__dirname, '../data/lastfmTopArtists.json');
    const outputPath = path.join(__dirname, '../data/lastfmArtists.json');
    const genreMapPath = path.join(__dirname, '../data/genreMap.json');

    const topArtists = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    const genreMap = JSON.parse(fs.readFileSync(genreMapPath, 'utf-8'));

    const detailedArtists = [];
    const seen = new Set();
    let i = 1;

    for (const { name, mbid, url } of topArtists) {
        if (i > MAX_ARTIST_LOOKUP) break;

        const normName = normalizeName(name);
        if (seen.has(normName)) continue;
        seen.add(normName);

        const encodedName = encodeURIComponent(name);
        const apiUrl = `${BASE_URL}?method=artist.getinfo&artist=${encodedName}&api_key=${API_KEY}&format=json`;

        try {
            const res = await fetch(apiUrl);
            const json = await res.json();
            const artist = json.artist;

            if (!artist) {
                console.warn(`❌ No artist data for ${name}`);
                continue;
            }

            const tags = (artist.tags?.tag || [])
                .map(tag => tag.name.toLowerCase())
                .filter(tag => genreMap.hasOwnProperty(tag));

            detailedArtists.push({
                name: artist.name,
                mbid: artist.mbid,
                url: artist.url,
                genres: tags
            });

            console.log(`(${i++}/${MAX_ARTIST_LOOKUP}) Processed: ${artist.name} (${tags.join(', ')})`);
        } catch (err) {
            console.warn(`⚠️ Failed to fetch details for ${name}: ${err.message}`);
        }
    }

    fs.writeFileSync(outputPath, JSON.stringify(detailedArtists, null, 2));
    console.log(`✅ Saved enriched artist data to lastfmArtists.json`);
}
