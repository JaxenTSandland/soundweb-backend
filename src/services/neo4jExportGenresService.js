import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import neo4j from 'neo4j-driver';
import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load topGenres.json
const topGenresPath = path.join(__dirname, '../data/topGenres.json');
const topGenres = JSON.parse(fs.readFileSync(topGenresPath, 'utf-8'));

// Neo4j connection
const uri = process.env.NEO4J_URI;
const user = process.env.NEO4J_USER;
const password = process.env.NEO4J_PASSWORD;
const topGenresDb = process.env.NEO4J_TOPGENRES_DB;

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
const session = driver.session({ database: topGenresDb });

export async function exportTopGenresToNeo4j() {
    try {
        // Clear the genre database
        await session.run(`MATCH (n) DETACH DELETE n`);

        // Insert each genre as a node
        for (const genre of topGenres) {
            await session.run(
                `MERGE (g:Genre {name: $name})
                 SET g.x = $x,
                     g.y = $y,
                     g.color = $color`,
                {
                    name: genre.name,
                    x: genre.x,
                    y: genre.y,
                    color: genre.color
                }
            );
        }

        console.log(`✅ Exported ${topGenres.length} genres to Neo4j database "${topGenresDb}"`);
    } catch (err) {
        console.error('❌ Error exporting genres to Neo4j:', err);
    } finally {
        await session.close();
        await driver.close();
    }
}
