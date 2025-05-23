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
import {
    checkAndReturnLastSyncCached,
    deleteFromCache,
    getFromCache,
    setLastSync,
    setToCache
} from "./services/redis.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uri = process.env.NEO4J_URI;
const user = process.env.NEO4J_USER;
const password = process.env.NEO4J_PASSWORD;
const topArtistsDb = process.env.NEO4J_TOPARTISTS_DB;

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
        const cached = await getFromCache(cacheKey);
        if (cached) return res.json(cached);

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

        await setToCache(cacheKey, responseData);

        res.json(responseData);

    } catch (err) {
        console.error("Error in /api/artists/expanded:", err);
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


    try {
        console.log(`GET - /api/artists/top?onlytopartists=${onlyTopArtists}&max=${max}`);

        const cached = await checkAndReturnLastSyncCached(cacheKey, res);
        if (cached) return;

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
                userTags: artist.userTags ?? [],
                x: neo4j.isInt(artist.x) ? artist.x.toNumber() : artist.x ?? 0,
                y: neo4j.isInt(artist.y) ? artist.y.toNumber() : artist.y ?? 0,
                relatedArtists: relatedIds,
                rank: artist.rank,
                lastUpdated: artist.lastUpdated
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
        const currentLastSync = await fetchLastSync();
        const data = {
            lastSync: String(currentLastSync),
            nodes,
            links
        };

        await setToCache(cacheKey, data);
        await setLastSync(String(currentLastSync));

        res.json({ lastSync: String(currentLastSync), ...responseData });
    } catch (err) {
        console.error("Error fetching artist graph from Neo4j:", err);
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

        const cached = await getFromCache(cacheKey);
        if (cached) return res.json(cached);

        const result = await session.run(`
    MATCH (a:Artist)
    WHERE $userTag IN a.userTags
    OPTIONAL MATCH (a)-[:RELATED_TO]-(b:Artist)
    WHERE $userTag IN b.userTags
    RETURN a, collect(DISTINCT b.id) AS relatedIds
`, { userTag });

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
                rank: neo4j.isInt(artist.rank) ? artist.rank.toNumber() : artist.rank ?? 0,
                lastUpdated: artist.lastUpdated
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
        await setToCache(cacheKey, responseData);
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
    const cacheKey = `artists:custom:no-topartist:${max}`;

    try {
        console.log(`GET - /api/artists/custom?max=${max}`);

        const cached = await getFromCache(cacheKey);
        if (cached) return res.json(cached);

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
                rank: neo4j.isInt(artist.rank) ? artist.rank.toNumber() : artist.rank ?? 0,
                lastUpdated: artist.lastUpdated
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
        await setToCache(cacheKey, responseData);

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

        const cacheKey = `genres:top:${count}`;
        const cached = await getFromCache(cacheKey);
        if (cached) return res.json(cached);

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

        await setToCache(cacheKey, selected);
        res.json(selected);
    } catch (err) {
        console.error('Error fetching top spaced genres from MySQL:', err);
        res.status(500).json({ error: 'Failed to load top genres' });
    }
});


app.get('/api/genres/all', async (req, res) => {
    try {
        console.log("GET - /api/genres/all");

        const cacheKey = `genres:all`;
        const cached = await getFromCache(cacheKey);
        if (cached) return res.json(cached);

        const [rows] = await sqlPool.execute(
            `SELECT name, x, y, color FROM genres`
        );

        await setToCache(cacheKey, rows);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching all genres from MySQL:', err);
        res.status(500).json({ error: 'Failed to load genres' });
    }
});

export async function fetchLastSync(session) {
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

// DELETE endpoint to clear a Redis cache key
app.delete('/api/cache', async (req, res) => {
    const key = req.query.key;
    if (!key) return res.status(400).json({ error: "Missing cache key" });
    console.log(`DELETE - /api/cache/${key}`);

    try {
        await deleteFromCache(key);
        res.json({ success: true, message: `Deleted Redis key: ${key}` });
    } catch (err) {
        console.error(`Failed to delete Redis key: ${key}`, err);
        res.status(500).json({ success: false, error: 'Redis delete failed' });
    }
});

app.post('/api/spotify/callback', async (req, res) => {
    const { code, code_verifier } = req.body;
    console.log(`POST - /api/spotify/callback`);

    if (!code || !code_verifier) {
        return res.status(400).json({ error: 'Missing code or code_verifier' });
    }

    try {
        // 1. Exchange code for access token
        const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.SPOTIFY_CLIENT_ID,
                grant_type: 'authorization_code',
                code,
                redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
                code_verifier
            })
        });

        if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            console.error('Token exchange failed:', errorText);
            return res.status(500).json({ error: 'Token exchange failed' });
        }

        const tokenJson = await tokenResponse.json();
        const accessToken = tokenJson.access_token;
        if (!accessToken) return res.status(500).json({ error: 'Missing access token' });

        // 2. Get user profile
        const profileRes = await fetch('https://api.spotify.com/v1/me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!profileRes.ok) {
            console.error('Failed to fetch profile:', await profileRes.text());
            return res.status(500).json({ error: 'Failed to fetch user profile' });
        }

        const userProfile = await profileRes.json();
        const userId = userProfile.id;
        const redisKey = `spotify:user:${userId}`;

        // 3. Check Redis for cached user + top artists
        const cached = await getFromCache(redisKey);
        if (cached) {
            return res.json(cached);
        }

        // 4. Fetch user's top artists from Spotify
        let offset = 0;
        const limit = 50;
        const topArtistIdsSet = new Set();

        while (true) {
            const topRes = await fetch(`https://api.spotify.com/v1/me/top/artists?time_range=long_term&limit=${limit}&offset=${offset}`, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });

            if (!topRes.ok) {
                console.error('Failed to fetch top artists:', await topRes.text());
                break;
            }

            const topJson = await topRes.json();
            const items = topJson.items || [];

            items.forEach(artist => topArtistIdsSet.add(artist.id));

            if (items.length < limit) break;
            offset += limit;
        }

        const topArtistIds = Array.from(topArtistIdsSet);

        const userData = {
            id: userId,
            display_name: userProfile.display_name,
            email: userProfile.email,
            images: userProfile.images,
            topSpotifyIds: topArtistIds
        };

        // 5. Cache it
        await setToCache(redisKey, userData, 86400);
        res.json(userData);

    } catch (err) {
        console.error('Error in /api/spotify/callback:', err);
        res.status(500).json({ error: 'Spotify login failed' });
    }
});

app.post('/api/graph/user/:userTag', async (req, res) => {
    const userTag = String(req.params.userTag);
    console.log(`POST - /api/graph/user/:userTag`);
    const spotifyIds = Array.from(new Set(req.body.spotify_ids));


    if (!userTag || !Array.isArray(spotifyIds) || spotifyIds.length === 0) {
        return res.status(400).json({ error: 'Missing user_tag or spotify_ids array' });
    }

    const cacheKey = `userGraph:${userTag}`;
    const cached = await getFromCache(cacheKey);
    if (cached) return res.json(cached);

    const session = driver.session({ database: topArtistsDb });

    try {
        const result = await session.run(`
            MATCH (a:Artist)
            WHERE a.spotifyId IN $ids AND $userTag IN a.userTags
            OPTIONAL MATCH (a)-[:RELATED_TO]-(b:Artist)
            RETURN a, collect(DISTINCT b.id) AS relatedIds
        `, {
            ids: spotifyIds,
            userTag
        });

        const nodeMap = new Map();
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
                genres: artist.genres ?? [],
                color: artist.color ?? null,
                x: neo4j.isInt(artist.x) ? artist.x.toNumber() : artist.x ?? 0,
                y: neo4j.isInt(artist.y) ? artist.y.toNumber() : artist.y ?? 0,
                userTags: artist.userTags ?? [],
                relatedArtists: relatedIds,
                rank: neo4j.isInt(artist.rank) ? artist.rank.toNumber() : artist.rank ?? 0,
                lastUpdated: artist.lastUpdated
            });

            nodeMap.set(artist.id, node.toDict());

            const sourceId = artist.id;
            for (const targetId of relatedIds) {
                const key = [sourceId, targetId].sort().join("-");
                linksSet.add(key);
            }
        }

        const links = Array.from(linksSet).map(link => {
            const [source, target] = link.split("-");
            return { source, target };
        });

        const nodes = Array.from(nodeMap.values());
        const foundCount = nodes.length;
        const totalCount = spotifyIds.length;
        const progress = totalCount > 0 ? foundCount / totalCount : 0;

        const responseData = {
            nodes,
            links,
            foundCount,
            totalCount,
            progress
        };

        if (foundCount >= totalCount) {
            await setToCache(cacheKey, responseData);
        }

        res.json(responseData);
    } catch (err) {
        console.error("Error in /api/graph/user/:userTag:", err);
        res.status(500).json({ error: "Failed to load user graph" });
    } finally {
        await session.close();
    }
});


app.get('/api/progress/user/:userTag', async (req, res) => {
    const session = driver.session({ database: topArtistsDb });
    const userTag = req.params.userTag;

    try {
        const result = await session.run(`
            MATCH (a:Artist)
            WHERE $userTag IN a.userTags
            RETURN count(a) AS artistCount
        `, { userTag });

        const record = result.records[0];
        const count = record?.get('artistCount')?.toNumber?.() ?? -1;

        res.json({ artistCount: count });
    } catch (err) {
        console.error("Error counting user-tagged artists:", err);
        res.status(500).json({ error: "Failed to count user-tagged artists" });
    } finally {
        await session.close();
    }
});

app.post('/api/users', async (req, res) => {
    const { user_tag, spotify_ids } = req.body;

    if (!user_tag || !Array.isArray(spotify_ids)) {
        return res.status(400).json({ error: "Missing user_tag or spotify_ids array" });
    }

    try {
        // 1. Check if user exists
        const [rows] = await sqlPool.execute(
            `SELECT * FROM users WHERE user_tag = ?`,
            [user_tag]
        );

        if (rows.length > 0) {
            return res.json({ success: true, message: "User already initialized", alreadyExists: true });
        }

        // 2. Save new user
        await sqlPool.execute(
            `INSERT INTO users (user_tag, spotify_id_count) VALUES (?, ?)`,
            [user_tag, spotify_ids.length]
        );

        // 3. Trigger ingestor ingestion
        fetch(`${process.env.INGESTOR_API_URL}/api/custom-artist/bulk`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_tag, spotify_ids })
        }).then(res => {
            console.log(`Ingestor accepted request for user ${user_tag} (${res.status})`);
        }).catch(err => {
            console.warn(`Ingestor request failed for user ${user_tag}:`, err.message);
        });

        return res.json({
            success: true,
            message: "User created and ingestor triggered in background."
        });
    } catch (err) {
        console.error("Error in /api/users:", err);
        res.status(500).json({ error: "Failed to create user" });
    }
});




export default app;
