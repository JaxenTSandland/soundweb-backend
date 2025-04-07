import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function normalizeName(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

export function combineAllArtistData() {
    const lastfmPath = path.join(__dirname, '../data/lastfmArtists.json');
    const spotifyPath = path.join(__dirname, '../data/spotifyArtists.json');
    const musicbrainzPath = path.join(__dirname, '../data/musicBrainzArtists.json');
    const genreMapPath = path.join(__dirname, '../data/genreMap.json');
    const outputPath = path.join(__dirname, '../data/artistData.json');

    const lastfmArtists = JSON.parse(fs.readFileSync(lastfmPath, 'utf-8'));
    const spotifyArtists = JSON.parse(fs.readFileSync(spotifyPath, 'utf-8'));
    const musicbrainzArtists = JSON.parse(fs.readFileSync(musicbrainzPath, 'utf-8'));
    const genreMap = JSON.parse(fs.readFileSync(genreMapPath, 'utf-8'));

    const lastfmMap = new Map();
    lastfmArtists.forEach(artist => {
        lastfmMap.set(normalizeName(artist.name), artist);
    });

    const musicbrainzMap = new Map();
    musicbrainzArtists.forEach(artist => {
        musicbrainzMap.set(normalizeName(artist.name), artist);
    });

    const seenNames = new Set();
    const merged = [];
    let idCounter = 1;

    for (const spotifyArtist of spotifyArtists) {
        const normName = normalizeName(spotifyArtist.name);
        if (seenNames.has(normName)) continue;

        const lastfmArtist = lastfmMap.get(normName);
        const musicbrainzArtist = musicbrainzMap.get(normName);
        if (!lastfmArtist && !musicbrainzArtist) continue;

        const genreFrequency = {};
        for (const genre of [...(lastfmArtist?.genres || []), ...(spotifyArtist.genres || []), ...(musicbrainzArtist?.genres || [])]) {
            const g = genre.toLowerCase();
            if (genreMap.hasOwnProperty(g)) {
                genreFrequency[g] = (genreFrequency[g] || 0) + 1;
            }
        }

        const genres = Object.entries(genreFrequency)
            .sort((a, b) => b[1] - a[1])
            .map(entry => entry[0]);

        if (genres.length === 0) continue;

        const topGenre = genres[0];
        const color = genreMap[topGenre]?.color || '#cccccc';

        // Use weighted average of top 10 genres using precomputed x/Y
        let xTotal = 0, yTotal = 0, weightTotal = 0;
        genres.slice(0, 10).forEach((g, index) => {
            const gData = genreMap[g];
            if (gData?.x != null && gData?.y != null) {
                const weight = 1 / (index + 1);
                xTotal += gData.x * weight;
                yTotal += gData.y * weight;
                weightTotal += weight;
            }
        });

        const x = weightTotal > 0 ? xTotal / weightTotal : undefined;
        const y = weightTotal > 0 ? yTotal / weightTotal : undefined;

        const imageUrl = spotifyArtist.imageUrl || lastfmArtist?.imageUrl || null;

        merged.push({
            id: `${idCounter++}`,
            name: spotifyArtist.name,
            genres,
            popularity: spotifyArtist.popularity,
            spotifyId: spotifyArtist.spotifyId,
            spotifyUrl: spotifyArtist.spotifyUrl,
            lastfmMBID: lastfmArtist?.mbid,
            imageUrl,
            relatedArtists: lastfmArtist?.similar || [],
            color,
            x,
            y
        });

        seenNames.add(normName);
    }

    fs.writeFileSync(outputPath, JSON.stringify(merged, null, 2), 'utf-8');
    console.log(`✅ Saved ${merged.length} enriched artists to artistData.json`);
}
