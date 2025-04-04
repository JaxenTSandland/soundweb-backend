import express from "express";
import { fetchTopArtistsFromLastFM } from "../services/lastfmService.js";

const router = express.Router();

router.get("/lastfm/top-artists", async (req, res) => {
    try {
        const data = await fetchTopArtistsFromLastFM();
        res.json(data);
    } catch (error) {
        console.error("Error fetching Last.fm data:", error);
        res.status(500).json({ error: "Failed to fetch Last.fm data" });
    }
});

export default router;
