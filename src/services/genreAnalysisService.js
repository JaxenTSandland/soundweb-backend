import neo4j from 'neo4j-driver';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uri = process.env.NEO4J_URI;
const user = process.env.NEO4J_USER;
const password = process.env.NEO4J_PASSWORD;
const topArtistsDb = process.env.NEO4J_TOPARTISTS_DB;

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

export async function analyzeAndUpdateGenreMap() {
    const session = driver.session({ database: topArtistsDb });
    const genreMapPath = path.join(__dirname, '../data/genreMap.json');

    try {
        const result = await session.run(`
            MATCH (a:Artist)
            RETURN a.genres AS genres
        `);

        const genreMap = JSON.parse(fs.readFileSync(genreMapPath, 'utf-8'));
        const genreCounts = {};

        for (const record of result.records) {
            const genres = record.get('genres');
            if (!Array.isArray(genres)) continue;

            genres.slice(0, 5).forEach(g => {
                const genre = g.toLowerCase();
                if (genreMap[genre]) {
                    genreCounts[genre] = (genreCounts[genre] || 0) + 1;
                }
            });
        }

        Object.entries(genreCounts).forEach(([genre, count]) => {
            if (!genreMap[genre]) return;
            genreMap[genre].count = count;
        });

        fs.writeFileSync(genreMapPath, JSON.stringify(genreMap, null, 2), 'utf-8');
        console.log(`✅ Updated genreMap.json`);
    } catch (err) {
        console.error('❌ Error analyzing genres:', err);
    } finally {
        await session.close();
        await driver.close();
    }
}
