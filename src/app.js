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

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

const app = express();
app.use(cors());
app.use(express.json());

const sqlPool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Health check route
app.get('/', (req, res) => {
    res.send('SoundWeb Backend is Running!');
});

//Serve artist data from Neo4j
app.get('/api/artists/graph', async (req, res) => {
    const session = driver.session({ database: topArtistsDb });

    try {
        console.log("GET - /api/artists/graph");
        const result = await session.run(`
            MATCH (a:Artist)
            OPTIONAL MATCH (a)-[:RELATED_TO]-(b:Artist)
            RETURN a, collect(DISTINCT b.id) AS relatedIds
        `);

        const nodes = [];
        const linksSet = new Set();

        for (const record of result.records) {
            const artist = record.get('a').properties;
            const relatedIds = record.get('relatedIds')
                ?.filter(id => id && typeof id === 'string') || [];

            nodes.push({
                id: artist.id,
                name: artist.name,
                popularity: neo4j.isInt(artist.popularity) ? artist.popularity.toNumber() : artist.popularity ?? 0,
                spotifyId: artist.spotifyId,
                spotifyUrl: artist.spotifyUrl,
                lastfmMBID: artist.lastfmMBID,
                imageUrl: artist.imageUrl,
                genres: artist.genres,
                color: artist.color,
                x: neo4j.isInt(artist.x) ? artist.x.toNumber() : artist.x ?? 0,
                y: neo4j.isInt(artist.y) ? artist.y.toNumber() : artist.y ?? 0
            });

            const sourceId = artist.id;
            relatedIds.forEach(targetId => {
                const key = [sourceId, targetId].sort().join("-");
                linksSet.add(key);
            });
        }

        const links = Array.from(linksSet).map(link => {
            const [source, target] = link.split("-");
            return { source, target };
        });

        res.json({ nodes, links });
    } catch (err) {
        console.error("❌ Error fetching artist graph from Neo4j:", err);
        res.status(500).json({ error: "Failed to load artist graph from Neo4j" });
    } finally {
        await session.close();
    }
});

app.get('/api/metadata/last-sync', async (req, res) => {
    const session = driver.session({ database: topArtistsDb });

    try {
        console.log("GET - /api/metadata/last-sync");

        const result = await session.run(`
            MATCH (meta:Metadata {type: "lastSync"})
            RETURN meta.timestamp AS timestamp
        `);

        const record = result.records[0];
        if (record && record.get("timestamp")) {
            const timestamp = record.get("timestamp");
            res.json({ lastSync: timestamp });
        } else {
            res.status(404).json({ error: "lastSync metadata not found" });
        }

    } catch (err) {
        console.error("❌ Error fetching metadata from Neo4j:", err);
        res.status(500).json({ error: "Failed to fetch lastSync metadata" });
    } finally {
        await session.close();
    }
});

app.get('/api/genres/top', async (req, res) => {
    try {
        console.log("GET - /api/genres/top");
        const count = parseInt(req.query.count) || 10;

        // Pull all non-zero genres from MySQL
        const [rows] = await sqlPool.execute(`
            SELECT name, x, y, color, count
            FROM genres
            WHERE count > 0
        `);

        // Sort by count descending
        const sorted = rows.sort((a, b) => b.count - a.count);

        // Euclidean distance calculation
        const distance = (g1, g2) => {
            const dx = g1.x - g2.x;
            const dy = g1.y - g2.y;
            return Math.sqrt(dx * dx + dy * dy);
        };

        const baseDistance = 2500;
        const minDistance = Math.floor(baseDistance * Math.sqrt(10 / count));

        // Select spaced-out top genres
        const selected = [];
        for (const genre of sorted) {
            const isTooClose = selected.some(sel => distance(genre, sel) < minDistance);
            if (!isTooClose) {
                selected.push(genre);
            }
            if (selected.length === count) break;
        }

        res.json(selected);
    } catch (err) {
        console.error('❌ Error fetching top spaced genres from MySQL:', err);
        res.status(500).json({ error: 'Failed to load top genres' });
    }
});


app.get('/api/genres/all', async (req, res) => {
    try {
        console.log("GET - /api/genres/all");
        const excludeZero = req.query.excludeZero === 'true';

        const [rows] = await sqlPool.execute(
            `SELECT name, x, y, color, count FROM genres ${excludeZero ? 'WHERE count > 0' : ''}`
        );

        res.json(rows);
    } catch (err) {
        console.error('❌ Error fetching all genres from MySQL:', err);
        res.status(500).json({ error: 'Failed to load genres' });
    }
});

export default app;
