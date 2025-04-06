import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = 'https://musicbrainz.org/ws/2/artist/';

function normalizeName(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, retries = 3, delayMs = 5000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            console.warn(`⚠️ Attempt ${attempt} failed: ${err.message}`);
            if (attempt < retries) await delay(delayMs);
        }
    }
    return null;
}

export async function fetchArtistsFromMusicBrainz() {
    const inputPath = path.join(__dirname, '../data/lastfmTopArtists.json');
    const genreMapPath = path.join(__dirname, '../data/genreMap.json');
    const outputPath = path.join(__dirname, '../data/musicBrainzArtists.json');

    const topArtists = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    const genreMap = JSON.parse(fs.readFileSync(genreMapPath, 'utf-8'));

    const results = [];
    const seen = new Set();
    let i = 1;

    for (const { name } of topArtists) {
        const normName = normalizeName(name);
        if (seen.has(normName)) continue;
        seen.add(normName);

        const url = `${BASE_URL}?query=artist:${encodeURIComponent(name)}&fmt=json`;
        const json = await fetchWithRetry(url);

        if (!json || !json.artists?.length) {
            console.warn(`❌ No match for ${name}`);
            continue;
        }

        const artist = json.artists[0];
        const tags = (artist.tags || [])
            .map(tag => tag.name.toLowerCase())
            .filter(tag => genreMap.hasOwnProperty(tag));

        results.push({
            name: artist.name,
            mbid: artist.id,
            genres: tags
        });

        console.log(`(${i++}) Processed: ${artist.name} (${tags.join(', ')})`);

    }

    fs.writeFileSync(outputPath, JSON.stringify([...allArtists.values()], null, 2));
    console.log(`✅ Saved ${allArtists.size} artists to lastfmTopArtists.json`);
}
