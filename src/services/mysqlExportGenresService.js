import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const genreMapPath = path.join(__dirname, '../data/genreMap.json');
const genreMap = JSON.parse(fs.readFileSync(genreMapPath, 'utf-8'));

const dbConfig = {
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE
};

export async function exportGenresToMySQL() {
    const connection = await mysql.createConnection(dbConfig);

    try {
        await connection.execute('DELETE FROM genres'); // Optional: clear existing

        const insertQuery = `
            INSERT INTO genres (name, x, y, color, count)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE x = VALUES(x), y = VALUES(y), color = VALUES(color), count = VALUES(count)
        `;

        for (const [name, data] of Object.entries(genreMap)) {
            const { x, y, color, count = 0 } = data;

            await connection.execute(insertQuery, [name, x, y, color, count]);
        }

        console.log(`✅ Exported ${Object.keys(genreMap).length} genres to MySQL`);
    } catch (err) {
        console.error('❌ Error exporting genres to MySQL:', err);
    } finally {
        await connection.end();
    }
}
