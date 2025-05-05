import { createClient } from 'redis';
import { fetchLastSync } from '../app.js'


const redis = createClient({
    url: process.env.REDIS_URL
});
await redis.connect();

const EX = process.env.REDIS_DATA_EXPIRATION_TIME_LIMIT || 3600;

export async function getFromCache(key) {
    try {
        const cached = await redis.get(key);
        if (cached) {
            console.log(`[Redis] cache hit for key: ${key}`);
            return JSON.parse(cached);
        } else {
            console.log(`[Redis] Cache miss for key: ${key}`);
            return null;
        }
    } catch (err) {
        console.error(`[Redis] Get error for key ${key}:`, err);
        return null;
    }
}

export async function setToCache(key, value, ex = EX) {
    try {
        await redis.set(key, JSON.stringify(value), { EX: ex });
        console.log(`[Redis] Set for key: ${key}`);
    } catch (err) {
        console.error(`[Redis] Set error for key ${key}:`, err);
    }
}

export async function deleteFromCache(key) {
    try {
        await redis.del(key);
        console.log(`[Redis] Deleted key: ${key}`);
    } catch (err) {
        console.error(`[Redis] Delete error for key ${key}:`, err);
    }
}

export async function checkAndReturnLastSyncCached(key, res) {
    try {
        const [cachedDataRaw, cachedLastSync, currentLastSync] = await Promise.all([
            redis.get(key),
            redis.get(`lastSync`),
            fetchLastSync()
        ]);

        if (cachedDataRaw && cachedLastSync && currentLastSync) {
            const cachedSyncStr = cachedLastSync.toString();
            const currentSyncStr = currentLastSync.toString();

            if (cachedSyncStr === currentSyncStr) {
                console.log(`[Redis] lastSync match – Serving from Redis key: ${key}`);
                return res.json(JSON.parse(cachedDataRaw));
            } else {
                console.log(`[Redis] Cache invalidated due to lastSync mismatch.`);
                await deleteFromCache(key);
            }
        }
        return null;
    } catch (err) {
        console.error(`[Redis] Error in lastSync cache check for key: ${key}`, err);
        return null;
    }
}

export async function setLastSync(value, ex = EX) {
    const lastSyncKey = `lastSync`;
    try {
        await redis.set(lastSyncKey, String(value), { EX: ex });
        console.log(`[Redis] LastSync set for key: ${lastSyncKey} = ${value}`);
    } catch (err) {
        console.error(`[Redis] Set error for lastSync key ${lastSyncKey}:`, err);
    }
}