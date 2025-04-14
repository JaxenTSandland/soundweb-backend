import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import neo4j from 'neo4j-driver';
import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const artistDataPath = path.join(__dirname, '../data/artistData.json');
const artistData = JSON.parse(fs.readFileSync(artistDataPath, 'utf-8'));

// Connect to Neo4j
const uri = process.env.NEO4J_URI;
const user = process.env.NEO4J_USER;
const password = process.env.NEO4J_PASSWORD;

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
const topArtistsDb = process.env.NEO4J_TOPARTISTS_DB
const session = driver.session({ database: topArtistsDb });

export async function exportTopArtistsToNeo4j() {
    try {

        await session.run(`MATCH (n) DETACH DELETE n`);
        for (const artist of artistData) {
            await session.run(
                `MERGE (a:Artist {id: $id})
                 SET a.name = $name,
                     a.popularity = $popularity,
                     a.spotifyId = $spotifyId,
                     a.spotifyUrl = $spotifyUrl,
                     a.imageUrl = $imageURL,
                     a.genres = $genres,
                     a.x = $x,
                     a.y = $y,
                     a.color = $color`,
                {
                    id: artist.id,
                    name: artist.name,
                    popularity: artist.popularity,
                    spotifyId: artist.spotifyId,
                    spotifyUrl: artist.spotifyUrl,
                    imageURL: artist.imageUrl,
                    genres: artist.genres,
                    x: artist.x,
                    y: artist.y,
                    color: artist.color
                }
            );
        }

        // Map artist names to IDs to match them quickly
        const nameToId = new Map();
        for (const artist of artistData) {
            nameToId.set(artist.name.toLowerCase(), artist.id);
        }

        // Create relationships
        const createdLinks = new Set();

        for (const artist of artistData) {
            const fromId = artist.id;
            const related = artist.relatedArtists || [];

            for (const relatedName of related) {
                const toId = nameToId.get(relatedName.toLowerCase());
                if (!toId || fromId === toId) continue;

                // Ensure order consistency
                const [id1, id2] = [fromId, toId].sort();
                const key = `${id1}-${id2}`;
                if (createdLinks.has(key)) continue;

                createdLinks.add(key);

                await session.run(
                    `MATCH (a:Artist {id: $id1}), (b:Artist {id: $id2})
                            MERGE (a)-[:RELATED_TO]-(b)`, // undirected relationship
                    { id1, id2 }
                );
            }
        }

        console.log("✅ Imported artists to Neo4j!");
    } catch (err) {
        console.error("❌ Error importing:", err);
    } finally {
        await session.close();
        await driver.close();
    }
}
