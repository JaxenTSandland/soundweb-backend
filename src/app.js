import express from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();
import neo4j from 'neo4j-driver';
import mysql from 'mysql2/promise';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uri = process.env.NEO4J_URI;
const user = process.env.NEO4J_USER;
const password = process.env.NEO4J_PASSWORD;
const topArtistsDb = process.env.NEO4J_TOPARTISTS_DB
const topGenresDb = process.env.NEO4J_TOPGENRES_DB;
const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

const app = express();
app.use(cors());
app.use(express.json());

const mysqlPool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE
});

// Health check route
app.get('/', (req, res) => {
    res.send('SoundWeb Backend is Running!');
});

// Serve artist data from Neo4j
app.get('/api/artists/all', async (req, res) => {
    const session = driver.session({ database: topArtistsDb });

    try {
        const result = await session.run(`
            MATCH (a:Artist)
            RETURN a
        `);

        const artists = result.records.map(record => {
            const a = record.get('a').properties;

            return {
                id: a.id,
                name: a.name,
                popularity: neo4j.isInt(a.popularity) ? a.popularity.toNumber() : a.popularity ?? 0,
                spotifyId: a.spotifyId,
                spotifyUrl: a.spotifyUrl,
                lastfmMBID: a.lastfmMBID,
                imageUrl: a.imageUrl,
                genres: a.genres,
                color: a.color,
                x: neo4j.isInt(a.x) ? a.x.toNumber() : a.x ?? 0,
                y: neo4j.isInt(a.y) ? a.y.toNumber() : a.y ?? 0,
                relatedArtists: a.relatedArtists || []
            };
        });

        res.json(artists);
    } catch (err) {
        console.error('❌ Error fetching from Neo4j:', err);
        res.status(500).json({ error: 'Failed to load data from Neo4j' });
    } finally {
        await session.close();
    }
});

app.get('/api/genres/top', async (req, res) => {
    try {
        const count = parseInt(req.query.count) || 10;

        // Load genreMap only
        const genreMap = JSON.parse(fs.readFileSync('./src/data/genreMap.json', 'utf-8'));

        // Filter out genres without a count or missing coordinates
        const genreEntries = Object.entries(genreMap)
            .filter(([_, g]) => typeof g.count === 'number' && g.count > 0 && g.x != null && g.y != null);

        // Sort by count descending
        const sortedGenres = genreEntries
            .sort((a, b) => b[1].count - a[1].count)
            .map(([name]) => name);

        // Euclidean distance (using x/y already scaled to 20k graph)
        const distance = (g1, g2) => {
            const dx = genreMap[g1].x - genreMap[g2].x;
            const dy = genreMap[g1].y - genreMap[g2].y;
            return Math.sqrt(dx * dx + dy * dy);
        };

        // Scale spacing
        const baseDistance = 2500;
        const minDistance = Math.floor(baseDistance * Math.sqrt(10 / count));

        // Select spaced-out top genres
        const selected = [];
        for (const genre of sortedGenres) {
            const isTooClose = selected.some(sel => distance(genre, sel) < minDistance);
            if (!isTooClose) {
                selected.push(genre);
            }
            if (selected.length === count) break;
        }

        // Build response
        const result = selected.map(name => {
            const g = genreMap[name];
            return {
                name,
                x: g.x,
                y: g.y,
                color: g.color,
                count: g.count
            };
        });

        res.json(result);
    } catch (err) {
        console.error('❌ Error fetching top spaced genres:', err);
        res.status(500).json({ error: 'Failed to load top genres' });
    }
});


app.get('/api/genres/all', async (req, res) => {
    const excludeZero = req.query.excludeZero === 'true';

    try {
        const query = excludeZero
            ? 'SELECT name, x, y, color, count FROM genres WHERE count > 0'
            : 'SELECT name, x, y, color, count FROM genres';

        const [rows] = await mysqlPool.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('❌ Error fetching all genres from MySQL:', err);
        res.status(500).json({ error: 'Failed to load genres' });
    }
});

export default app;
