import express from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Health check route
app.get('/', (req, res) => {
    res.send('SoundWeb Backend is Running!');
});

// Serve artist data from local JSON file
app.get('/api/artists/all', (req, res) => {
    const dataPath = path.join(__dirname, 'data', 'artistData.json');

    fs.readFile(dataPath, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading artistData.json:', err);
            return res.status(500).json({ error: 'Failed to load artist data.' });
        }

        try {
            const artists = JSON.parse(data);
            res.json(artists);
        } catch (parseErr) {
            console.error('Error parsing artistData.json:', parseErr);
            res.status(500).json({ error: 'Invalid artist data format.' });
        }
    });
});

app.get('/api/genres/top', (req, res) => {
    const dataPath = path.join(__dirname, 'data', 'topGenres.json');

    fs.readFile(dataPath, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading topGenres.json:', err);
            return res.status(500).json({ error: 'Failed to load top genres.' });
        }

        try {
            const genres = JSON.parse(data);
            res.json(genres);
        } catch (parseErr) {
            console.error('Error parsing topGenres.json:', parseErr);
            res.status(500).json({ error: 'Invalid top genre data format.' });
        }
    });
});

export default app;
