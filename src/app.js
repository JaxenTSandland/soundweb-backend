import express from 'express';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';
import mysql from 'mysql2/promise';
import {
    fetchRecentReleases,
    fetchTopSpotifyIdsForUser, fetchTopSpotifyTrackIds,
    fetchTopTracks, getAccessTokenFromRefresh,
    getSpotifyAccessToken
} from "./services/Spotify.js";
import {fetchArtistBio} from "./services/lastfm.js";
import {ArtistNode} from "./models/artistNode.js";
import {
    checkAndReturnLastSyncCached,
    deleteFromCache,
    getFromCache,
    setLastSync,
    setToCache
} from "./services/redis.js";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uri = process.env.NEO4J_URI;
const user = process.env.NEO4J_USER;
const password = process.env.NEO4J_PASSWORD;
const topArtistsDb = process.env.NEO4J_TOPARTISTS_DB;

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

const app = express();
const allowedOrigins = process.env.RAILWAY_ENVIRONMENT_NAME === "production" ? [
    "https://soundweb.app",
    "https://soundweb.up.railway.app"
] : [
    "http://localhost:5173"
];
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (Postman, curl, SSR)
        if (!origin) return callback(null, true);

        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        } else {
            return callback(new Error("Not allowed by CORS: " + origin));
        }
    },
    credentials: true
}));

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

// Get all artist nodes (no links, no filters)
app.get('/api/artists/all', async (req, res) => {
    const session = driver.session({ database: topArtistsDb });

    try {
        console.log("GET - /api/artists/all");

        const result = await session.run(`
            MATCH (a:Artist)
            RETURN a
        `);

        const nodes = [];

        for (const record of result.records) {
            const artist = record.get('a').properties;

            const node = new ArtistNode({
                id: artist.id,
                name: artist.name,
                popularity: neo4j.isInt(artist.popularity) ? artist.popularity.toNumber() : artist.popularity ?? 0,
                spotifyId: artist.id,
                spotifyUrl: artist.spotifyUrl ?? null,
                lastfmMBID: artist.lastfmMBID ?? null,
                imageUrl: artist.imageUrl ?? null,
                genres: artist.genres ?? [],
                color: artist.color ?? null,
                userTags: artist.userTags ?? [],
                x: neo4j.isInt(artist.x) ? artist.x.toNumber() : artist.x ?? 0,
                y: neo4j.isInt(artist.y) ? artist.y.toNumber() : artist.y ?? 0,
                relatedArtists: [],
                rank: neo4j.isInt(artist.rank) ? artist.rank.toNumber() : artist.rank ?? 0,
                lastUpdated: artist.lastUpdated
            });

            nodes.push(node.toDict());
        }

        res.json({ nodes });
    } catch (err) {
        console.error("Error fetching all artist nodes:", err);
        res.status(500).json({ error: "Failed to load all artist nodes" });
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
        // Exchange code for access token
        const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
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

        if (!tokenRes.ok) {
            const errorText = await tokenRes.text();
            console.error('Token exchange failed:', errorText);
            return res.status(500).json({ error: 'Token exchange failed' });
        }

        const tokenJson = await tokenRes.json();
        const accessToken = tokenJson.access_token;
        const refreshToken = tokenJson.refresh_token || null;

        if (!accessToken) return res.status(500).json({ error: 'Missing access token' });

        // Fetch user profile
        const profileRes = await fetch('https://api.spotify.com/v1/me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!profileRes.ok) {
            console.error('Failed to fetch profile:', await profileRes.text());
            return res.status(profileRes.status).json({ error: 'Failed to fetch user profile' });
        }

        const userProfile = await profileRes.json();
        const userId = userProfile.id;
        const displayName = userProfile.display_name || null;

        // Update MySQL
        const [rows] = await sqlPool.execute(
            `SELECT user_tag FROM users WHERE user_tag = ?`,
            [userId]
        );

        if (rows.length > 0) {
            await sqlPool.execute(
                `UPDATE users SET display_name = ?, last_logged_in = NOW()${refreshToken ? ', refresh_token = ?' : ''} WHERE user_tag = ?`,
                refreshToken
                    ? [displayName, refreshToken, userId]
                    : [displayName, userId]
            );
        } else {
            await sqlPool.execute(
                `INSERT INTO users (user_tag, display_name, ${refreshToken ? 'refresh_token, ' : ''}last_logged_in)
                 VALUES (?, ?, ${refreshToken ? '?, ' : ''}NOW())`,
                refreshToken
                    ? [userId, displayName, refreshToken]
                    : [userId, displayName]
            );
        }

        const userData = {
            id: userId,
            display_name: displayName,
            email: userProfile.email,
            images: userProfile.images
        };

        const redisKey = `spotify:user:${userId}`;
        await setToCache(redisKey, userData, 86400);

        res.json(userData);

    } catch (err) {
        console.error('Error in /api/spotify/callback:', err);
        res.status(500).json({ error: 'Spotify login failed' });
    }
});

app.get('/api/graph/user/:userTag', async (req, res) => {
    const userTag = String(req.params.userTag);
    console.log(`GET - /api/graph/user/:userTag`);

    if (!userTag) {
        return res.status(400).json({ error: 'Missing user_tag' });
    }

    const cacheKey = `userGraph:${userTag}`;
    const cached = await getFromCache(cacheKey);
    if (cached) return res.json(cached);

    const session = driver.session({ database: topArtistsDb });

    try {
        const result = await session.run(`
            MATCH (a:Artist)
            WHERE $userTag IN a.userTags
            OPTIONAL MATCH (a)-[:RELATED_TO]-(b:Artist)
            RETURN a, collect(DISTINCT b.id) AS relatedIds
        `, { userTag });

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

        const responseData = {
            nodes: Array.from(nodeMap.values()),
            links
        };

        await setToCache(cacheKey, responseData);
        res.json(responseData);
    } catch (err) {
        console.error("Error in /api/graph/user/:userTag:", err);
        res.status(500).json({ error: "Failed to load user graph" });
    } finally {
        await session.close();
    }
});

app.get('/api/progress/user/:userTag', async (req, res) => {
    const userTag = req.params.userTag;
    const session = driver.session({ database: topArtistsDb });

    console.log(`GET - /api/progress/user/:userTag`);

    try {
        const latestIngestKey = `ingest:latest:${userTag}`;
        const importingNow = await getFromCache(latestIngestKey);

        // Get how many Spotify IDs were originally submitted
        const [rows] = await sqlPool.execute(
            `SELECT spotify_id_count FROM users WHERE user_tag = ?`,
            [userTag]
        );
        const totalCount = rows[0]?.spotify_id_count ?? 0;
        if (totalCount === 0) {
            return res.status(404).json({ error: "No artists found for user" });
        }

        // Count how many artists were successfully ingested
        const result = await session.run(`
            MATCH (a:Artist)
            WHERE $userTag IN a.userTags
            RETURN count(a) AS foundCount
        `, { userTag });
        const foundCount = result.records[0]?.get('foundCount')?.toNumber() ?? 0;

        // Count how many were marked as failed
        const [incompleteRows] = await sqlPool.execute(
            `SELECT COUNT(*) AS count FROM incomplete_artists WHERE user_tag = ?`,
            [userTag]
        );
        const incompleteCount = incompleteRows[0]?.count ?? 0;

        // Adjusted total: only count those that are either found or still pending
        const adjustedTotal = totalCount - incompleteCount;
        const progress = adjustedTotal > 0 ? foundCount / adjustedTotal : 1;


        console.log(`(F:${foundCount} I:${incompleteCount} T:${totalCount} P:${progress.toFixed(2) * 100}%)`);

        res.json({
            foundCount,
            incompleteCount,
            totalCount,
            adjustedTotal,
            progress,
            importingNow
        });
    } catch (err) {
        console.error("Progress check failed:", err);
        res.status(500).json({ error: "Progress check failed" });
    } finally {
        await session.close();
    }
});

app.delete('/api/usertags/:userTag', async (req, res) => {
    const userTag = req.params.userTag;
    const session = driver.session({ database: topArtistsDb });

    console.log(`DELETE - /api/usertags/${userTag}`);

    try {
        // Remove user tag from Neo4j artist nodes
        const result = await session.run(`
            MATCH (a:Artist)
            WHERE $userTag IN a.userTags
            SET a.userTags = [tag IN a.userTags WHERE tag <> $userTag]
            RETURN count(a) AS updatedCount
        `, { userTag });

        const updatedCount = result.records[0].get('updatedCount').toNumber();

        // Delete from Redis
        const keysToDelete = [
            `userGraph:${userTag}`,
            `artists:by-usertag:${userTag}`,
            `userTop:${userTag}`,
            `spotify:user:${userTag}`
        ];
        await Promise.all(keysToDelete.map(key => deleteFromCache(key)));

        // Delete from MySQL
        const mysqlConn = await sqlPool.getConnection();
        try {
            await mysqlConn.beginTransaction();

            await mysqlConn.execute(
                `DELETE FROM incomplete_artists WHERE user_tag = ?`,
                [userTag]
            );

            await mysqlConn.execute(
                `DELETE FROM users WHERE user_tag = ?`,
                [userTag]
            );

            await mysqlConn.commit();
        } catch (sqlErr) {
            await mysqlConn.rollback();
            throw sqlErr;
        } finally {
            mysqlConn.release();
        }

        res.json({
            success: true,
            updatedCount,
            clearedCacheKeys: keysToDelete,
            removedFromMySQL: true
        });
    } catch (err) {
        console.error(`Failed to fully delete userTag "${userTag}":`, err);
        res.status(500).json({ error: 'Failed to remove userTag from Neo4j, Redis, or MySQL' });
    } finally {
        await session.close();
    }
});

app.post("/api/users/ping", async (req, res) => {
    const { user_tag } = req.body;
    if (!user_tag) {
        return res.status(400).json({ error: "Missing user_tag" });
    }

    console.log(`POST - /api/users/ping`);

    try {
        const [rows] = await sqlPool.execute(
            `SELECT refresh_token FROM users WHERE user_tag = ?`,
            [user_tag]
        );

        const storedRefreshToken = rows[0]?.refresh_token;
        if (!storedRefreshToken) {
            return res.status(400).json({ error: "No refresh token found for user" });
        }

        let accessToken;
        let finalRefreshToken;

        try {
            const { access_token, new_refresh_token } = await getAccessTokenFromRefresh(storedRefreshToken);
            accessToken = access_token;
            finalRefreshToken = new_refresh_token || storedRefreshToken;
        } catch (err) {
            console.warn(`[AUTH] Refresh token failed for ${user_tag}, clearing token...`);
            await sqlPool.execute(`UPDATE users SET refresh_token = NULL WHERE user_tag = ?`, [user_tag]);
            return res.status(401).json({ error: "Refresh token invalid. Please re-login." });
        }

        await sqlPool.execute(
            `UPDATE users SET refresh_token = ?, last_logged_in = NOW() WHERE user_tag = ?`,
            [finalRefreshToken, user_tag]
        );

        const latestIds = await fetchTopSpotifyIdsForUser(accessToken);
        const uniqueSpotifyIds = Array.from(new Set(latestIds));

        await sqlPool.execute(
            `UPDATE users SET spotify_id_count = ? WHERE user_tag = ?`,
            [uniqueSpotifyIds.length, user_tag]
        );

        fetch(`${process.env.INGESTOR_API_URL}/api/custom-artist/bulk`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_tag, spotify_ids: uniqueSpotifyIds })
        });

        // Fetch top track IDs
        //const topTrackIds = await fetchTopSpotifyTrackIds(accessToken);
        // res.json({
        //     reingested: true,
        //     spotify_ids: uniqueSpotifyIds,
        //     top_track_ids: topTrackIds
        // });

        res.json({
            reingested: true,
            spotify_ids: uniqueSpotifyIds
        });
    } catch (err) {
        console.error("Ping ingestion failed:", err);
        res.status(500).json({ error: "Ping failed" });
    }
});



export default app;
