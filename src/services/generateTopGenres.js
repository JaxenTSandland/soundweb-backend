import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const maxX = 1500;
const maxY = 22500;
const graphMaxX = 20000;
const graphMaxY = 20000;

export async function generateTopGenres() {
    const genreMapPath = path.join(__dirname, '../data/genreMap.json');
    const artistDataPath = path.join(__dirname, '../data/artistData.json');
    const outputPath = path.join(__dirname, '../data/topGenres.json');

    const genreMap = JSON.parse(fs.readFileSync(genreMapPath, 'utf-8'));
    const artistData = JSON.parse(fs.readFileSync(artistDataPath, 'utf-8'));

    // Count genre frequencies
    const genreCounts = {};
    artistData.forEach(artist => {
        artist.genres.slice(0, 3).forEach(genre => {
            const lower = genre.toLowerCase();
            if (genreMap[lower]) {
                genreCounts[lower] = (genreCounts[lower] || 0) + 1;
            }
        });
    });

    // Sort genres by frequency
    const sortedGenres = Object.entries(genreCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([genre]) => genre);

    // Helper to compute Euclidean distance
    function distance(g1, g2) {
        const dx = genreMap[g1].x - genreMap[g2].x;
        const dy = genreMap[g1].y - genreMap[g2].y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    const selected = [];
    const minDistance = 1200; // Minimum distance between genres

    for (const genre of sortedGenres) {
        const isTooClose = selected.some(sel => distance(genre, sel) < minDistance);
        if (!isTooClose) {
            selected.push(genre);
        }
        if (selected.length === 10) break;
    }

    const topGenres = selected.map(name => {
        const g = genreMap[name];
        return {
            name,
            x: (g.x / maxX) * graphMaxX,
            y: (g.y / maxY) * graphMaxY,
            color: g.color
        };
    });

    fs.writeFileSync(outputPath, JSON.stringify(topGenres, null, 2), 'utf-8');
    console.log(`✅ Saved top ${topGenres.length} spaced-out genres to topGenres.json`);
}
