import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const maxX = 1500;
const maxY = 22500;
const graphMaxX = 20000;
const graphMaxY = 20000;

function normalizeName(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

export function combineLastfmAndSpotifyData() {
    const lastfmPath = path.join(__dirname, '../data/lastfmArtists.json');
    const spotifyPath = path.join(__dirname, '../data/spotifyArtists.json');
    const genreMapPath = path.join(__dirname, '../data/genreMap.json');
    const outputPath = path.join(__dirname, '../data/artistData.json');

    const lastfmArtists = JSON.parse(fs.readFileSync(lastfmPath, 'utf-8'));
    const spotifyArtists = JSON.parse(fs.readFileSync(spotifyPath, 'utf-8'));
    const genreMap = JSON.parse(fs.readFileSync(genreMapPath, 'utf-8'));

    const lastfmMap = new Map();
    lastfmArtists.forEach(artist => {
        lastfmMap.set(normalizeName(artist.name), artist);
    });

    const seenNames = new Set();
    const merged = [];
    let idCounter = 1;

    for (const spotifyArtist of spotifyArtists) {
        const normName = normalizeName(spotifyArtist.name);
        if (seenNames.has(normName)) continue;

        const lastfmArtist = lastfmMap.get(normName);
        if (!lastfmArtist) continue;

        const genreSet = new Set([
            ...(lastfmArtist.genres || []),
            ...(spotifyArtist.genres || [])
        ]);
        const genres = Array.from(genreSet).filter(
            genre => genreMap.hasOwnProperty(genre.toLowerCase())
        );

        if (genres.length === 0) continue;

        const topGenre = genres[0].toLowerCase();
        const color = genreMap[topGenre]?.color || '#cccccc';

        let xTotal = 0, yTotal = 0, weightTotal = 0;
        genres.slice(0, 10).forEach((g, index) => {
            const gData = genreMap[g.toLowerCase()];
            if (gData?.x != null && gData?.y != null) {
                const weight = 1 / (index + 1); // higher weight for earlier genres
                xTotal += ((gData.x / maxX) * graphMaxX) * weight;
                yTotal += ((gData.y / maxY) * graphMaxY) * weight;
                weightTotal += weight;
            }
        });

        const x = weightTotal > 0 ? xTotal / weightTotal : undefined;
        const y = weightTotal > 0 ? yTotal / weightTotal : undefined;

        merged.push({
            id: `${idCounter++}`,
            name: spotifyArtist.name,
            genres,
            popularity: spotifyArtist.popularity,
            spotifyId: spotifyArtist.spotifyId,
            spotifyUrl: spotifyArtist.spotifyUrl,
            color,
            x,
            y
        });

        seenNames.add(normName);
    }

    fs.writeFileSync(outputPath, JSON.stringify(merged, null, 2), 'utf-8');
    console.log(`✅ Saved ${merged.length} enriched artists to artistData.json`);
}
