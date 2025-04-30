import express from 'express';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();
import neo4j from 'neo4j-driver';
import mysql from 'mysql2/promise';
import {fetchRecentReleases, fetchTopTracks, getSpotifyAccessToken} from "./services/Spotify.js";
import {fetchArtistBio} from "./services/lastfm.js";
import {ArtistNode} from "./models/artistNode.js";
import { createClient } from 'redis';


const redis = createClient({
    url: process.env.REDIS_URL
});
await redis.connect();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uri = process.env.NEO4J_URI;
const user = process.env.NEO4J_USER;
const password = process.env.NEO4J_PASSWORD;
const topArtistsDb = process.env.NEO4J_TOPARTISTS_DB
const REDIS_DATA_EXPIRATION_TIME_LIMIT = 3600; // One hour

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

const app = express();
app.use(cors());
app.use(express.json());

const sqlPool = mysql.createPool({
    host: process.env.MYSQLHOST,
    port: process.env.MYSQLPORT,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});



// Health check route
app.get('/', (req, res) => {
    res.send('SoundWeb Backend is Running!');
});

app.get('/api/redis-test', async (req, res) => {
    await redis.set('testkey', 'hello world');
    const value = await redis.get('testkey');
    res.send(`Value from Redis: ${value}`);
});

app.get('/api/artists/:spotifyid/expanded', async (req, res) => {
    const spotifyID = req.params.spotifyid;
    const market = req.query.market || 'US';
    const artistName = req.query.name;
    const lastfmMBID = req.query.mbid;

    const cacheKey = `expanded:${spotifyID}:${market}`;

    try {
        console.log(`GET - /api/artists/${spotifyID}/expanded?artistName=${artistName}&market=${market}&lastfmMBID=${lastfmMBID}`);
        const cached = await redis.get(cacheKey);
        if (cached) {
            console.log(`Cache hit for ${cacheKey}`);
            return res.json(JSON.parse(cached));
        }

        console.log(`Cache miss for ${cacheKey}. Fetching from APIs.`);

        const spotifyAccessToken = await getSpotifyAccessToken();

        // Spotify: Top Tracks
        const topTracks = await fetchTopTracks({
            spotifyID: spotifyID,
            market: market,
            accessToken: spotifyAccessToken
        });

        // Spotify: Recent Release
        const recentReleases = await fetchRecentReleases({
            spotifyID: spotifyID,
            market: market,
            accessToken: spotifyAccessToken
        });

        // Last.fm: Artist Bio
        const bio = await fetchArtistBio({ name: artistName, mbid: lastfmMBID });

        const responseData = {
            artistSpotifyId: spotifyID,
            topTracks,
            recentReleases,
            bio
        };

        await redis.set(cacheKey, JSON.stringify(responseData), {
            EX: REDIS_DATA_EXPIRATION_TIME_LIMIT
        });

        res.json(responseData);

    } catch (err) {
        console.error("❌ Error in /api/artists/expanded:", err);
        console.log(req.query);
        res.status(500).json({ error: "Failed to expand artist info" });
    }
});

// Serve artist data from Neo4j
app.get('/api/artists/top', async (req, res) => {
    const session = driver.session({ database: topArtistsDb });
    const max = Number.isInteger(parseInt(req.query.max)) ? parseInt(req.query.max) : 1000;

    // Proper boolean parsing
    let onlyTopArtists = true;
    if (req.query.onlytopartists !== undefined) {
        onlyTopArtists = req.query.onlytopartists === 'true' || req.query.onlytopartists === '1';
    }

    const cacheKey = `artistGraph:${onlyTopArtists ? 'top' : 'all'}:${max}`;
    const lastSyncKey = `lastSync`;

    try {
        console.log(`GET - /api/artists/top?onlytopartists=${onlyTopArtists}&max=${max}`);

        const cachedGraph = await redis.get(cacheKey);
        const cachedLastSync = await redis.get(lastSyncKey);
        const currentLastSync = await fetchLastSync();

        if (cachedGraph && cachedLastSync && currentLastSync) {
            if (cachedLastSync.toString() === currentLastSync.toString()) {
                console.log(`Serving artist graph from Redis cache.`);
                return res.json(JSON.parse(cachedGraph));
            } else {
                console.log(`Cache invalidated. lastSync mismatch.`);
                await redis.del(cacheKey);
            }
        }

        // If cache doesn't exist or is invalid, rebuild
        const label = onlyTopArtists ? "TopArtist" : "Artist";

        const result = await session.run(`
            MATCH (a:${label})
            OPTIONAL MATCH (a)-[:RELATED_TO]-(b:${label})
            RETURN a, collect(DISTINCT b.id) AS relatedIds
            LIMIT ${max}
        `, { max });

        const nodes = [];
        const linksSet = new Set();

        for (const record of result.records) {
            const artist = record.get('a').properties;
            const relatedIds = record.get('relatedIds')?.filter(id => id && typeof id === 'string') || [];

            const node = new ArtistNode({
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
                y: neo4j.isInt(artist.y) ? artist.y.toNumber() : artist.y ?? 0,
                relatedArtists: relatedIds,
                rank: artist.rank,
            });

            nodes.push(node.toDict());

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

        const responseData = { nodes, links };


        await redis.set(cacheKey, JSON.stringify({
            lastSync: String(currentLastSync),
            nodes,
            links
        }), { EX: REDIS_DATA_EXPIRATION_TIME_LIMIT });


        await redis.set(lastSyncKey, String(currentLastSync), { EX: REDIS_DATA_EXPIRATION_TIME_LIMIT });

        res.json({ lastSync: String(currentLastSync), ...responseData });
    } catch (err) {
        console.error("❌ Error fetching artist graph from Neo4j:", err);
        res.status(500).json({ error: "Failed to load artist graph from Neo4j" });
    } finally {
        await session.close();
    }
});


// Get all artists with a specific user tag
app.get('/api/artists/by-usertag/:userTag', async (req, res) => {
    const session = driver.session({ database: topArtistsDb });
    const userTag = req.params.userTag;
    const cacheKey = `artists:by-usertag:${userTag}`;

    try {
        console.log(`GET - /api/artists/by-usertag/${userTag}`);

        const cached = await redis.get(cacheKey);
        if (cached) {
            console.log(`Serving /by-usertag/${userTag} from Redis cache.`);
            return res.json(JSON.parse(cached));
        }

        const result = await session.run(`
            MATCH (a:Artist)
            WHERE $userTag IN a.userTags
            RETURN a
        `, { userTag });

        const nodes = result.records.map(record => {
            const artist = record.get('a').properties;
            return new ArtistNode({
                id: artist.id,
                name: artist.name,
                popularity: neo4j.isInt(artist.popularity) ? artist.popularity.toNumber() : artist.popularity ?? 0,
                spotifyId: artist.spotifyId ?? null,
                spotifyUrl: artist.spotifyUrl ?? null,
                lastfmMBID: artist.lastfmMBID ?? null,
                imageUrl: artist.imageUrl ?? null,
                genres: artist.genres ?? [],
                x: neo4j.isInt(artist.x) ? artist.x.toNumber() : artist.x ?? null,
                y: neo4j.isInt(artist.y) ? artist.y.toNumber() : artist.y ?? null,
                color: artist.color ?? null,
                userTags: artist.userTags ?? [],
                relatedArtists: [],
                rank: neo4j.isInt(artist.rank) ? artist.rank.toNumber() : artist.rank ?? 0
            }).toDict();
        });

        const responseData = { nodes };
        await redis.set(cacheKey, JSON.stringify(responseData), { EX: REDIS_DATA_EXPIRATION_TIME_LIMIT });

        res.json(responseData);
    } catch (err) {
        console.error("❌ Error fetching artists by userTag:", err);
        res.status(500).json({ error: "Failed to fetch artists by userTag" });
    } finally {
        await session.close();
    }
});

// Get all artists without the TopArtist label
app.get('/api/artists/custom', async (req, res) => {
    const session = driver.session({ database: topArtistsDb });
    const max = Number.isInteger(parseInt(req.query.max)) ? parseInt(req.query.max) : 1000;
    const cacheKey = `artists:custom:no-topartist-with-links:${max}`;

    try {
        console.log(`GET - /api/artists/custom?max=${max}`);

        const cached = await redis.get(cacheKey);
        if (cached) {
            console.log(`Serving /custom from Redis cache.`);
            return res.json(JSON.parse(cached));
        }

        const result = await session.run(`
            MATCH (a:Artist)
            WHERE NOT a:TopArtist
            OPTIONAL MATCH (a)-[:RELATED_TO]-(b:Artist)
            WHERE NOT b:TopArtist
            RETURN a, collect(DISTINCT b.id) AS relatedIds
            LIMIT ${max}
        `, { max });

        const nodes = [];
        const linksSet = new Set();

        for (const record of result.records) {
            const artist = record.get('a').properties;
            const relatedIds = record.get('relatedIds')?.filter(id => id && typeof id === 'string') || [];

            const node = new ArtistNode({
                id: artist.id,
                name: artist.name,
                popularity: neo4j.isInt(artist.popularity) ? artist.popularity.toNumber() : artist.popularity ?? 0,
                spotifyId: artist.spotifyId ?? null,
                spotifyUrl: artist.spotifyUrl ?? null,
                lastfmMBID: artist.lastfmMBID ?? null,
                imageUrl: artist.imageUrl ?? null,
                genres: artist.genres ?? [],
                x: neo4j.isInt(artist.x) ? artist.x.toNumber() : artist.x ?? null,
                y: neo4j.isInt(artist.y) ? artist.y.toNumber() : artist.y ?? null,
                color: artist.color ?? null,
                userTags: artist.userTags ?? [],
                relatedArtists: relatedIds,
                rank: neo4j.isInt(artist.rank) ? artist.rank.toNumber() : artist.rank ?? 0
            });

            nodes.push(node.toDict());

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

        const responseData = { nodes, links };
        await redis.set(cacheKey, JSON.stringify(responseData), { EX: REDIS_DATA_EXPIRATION_TIME_LIMIT });

        res.json(responseData);
    } catch (err) {
        console.error("❌ Error fetching custom artist graph:", err);
        res.status(500).json({ error: "Failed to fetch custom artist graph" });
    } finally {
        await session.close();
    }
});


app.get('/api/metadata/last-sync', async (req, res) => {
    const session = driver.session({ database: topArtistsDb });

    try {
        const updatedAt = await fetchLastSync(session);

        if (!updatedAt) {
            return res.status(404).json({ error: "lastSync metadata not found" });
        }

        res.json({ lastSync: updatedAt });
    } catch (err) {
        console.error("Error fetching lastSync metadata from Neo4j:", err);
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

async function fetchLastSync(session) {
    let ownSession = false;
    if (!session) {
        session = driver.session({ database: topArtistsDb });
        ownSession = true;
    }

    try {
        const lastSyncResult = await session.run(`
            MATCH (n:Metadata {name: "lastSync"})
            RETURN n.updatedAt AS updatedAt
            LIMIT 1
        `);
        const record = lastSyncResult.records[0];
        return record?.get('updatedAt');
    } finally {
        if (ownSession) {
            await session.close();
        }
    }
}




export default app;
