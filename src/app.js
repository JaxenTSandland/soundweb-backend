import express from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();
import neo4j from 'neo4j-driver';

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
    const session = driver.session({ database: topGenresDb });

    try {
        const result = await session.run(`
            MATCH (g:Genre)
            RETURN g
        `);

        const genres = result.records.map(record => {
            const g = record.get('g').properties;
            return {
                name: g.name,
                x: neo4j.isInt(g.x) ? g.x.toNumber() : g.x ?? 0,
                y: neo4j.isInt(g.y) ? g.y.toNumber() : g.y ?? 0,
                color: g.color
            };
        });

        res.json(genres);
    } catch (err) {
        console.error('❌ Error fetching top genres from Neo4j:', err);
        res.status(500).json({ error: 'Failed to load top genres from Neo4j' });
    } finally {
        await session.close();
    }
});

export default app;
