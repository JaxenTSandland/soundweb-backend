const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const cors = require('cors');
app.use(cors());

app.use(express.json());

// Health check route
app.get('/', (req, res) => {
    res.send('SoundWeb Backend is Running!!');
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

module.exports = app;
