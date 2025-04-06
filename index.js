import dotenv from 'dotenv';
import app from './src/app.js';
import {fetchArtistsFromMusicBrainz} from "./src/services/musicBrainzService.js";

const RELOAD_LASTFM_DATA = false;
const RELOAD_MUSICBRAINZ_DATA = false;
const RELOAD_SPOTIFY_DATA = false;
const RELOAD_COMBINE_DATA = false;
const GENERATE_TOP_GENRES = false;
const EXPORT_TO_NEO4J = true;

dotenv.config();

const PORT = process.env.PORT || 3000;

if (
    RELOAD_LASTFM_DATA ||
    RELOAD_MUSICBRAINZ_DATA ||
    RELOAD_SPOTIFY_DATA ||
    RELOAD_COMBINE_DATA ||
    GENERATE_TOP_GENRES ||
    EXPORT_TO_NEO4J
) {
    const { fetchTopArtistsFromLastFM, fetchArtistDetailsFromLastFM } =
        await import('./src/services/lastfmService.js');
    const { fetchArtistsFromMusicBrainz } = await import('./src/services/musicBrainzService.js');
    const { fetchAndSaveSpotifyArtists } = await import('./src/services/spotifyService.js');
    const { combineLastfmAndSpotifyData } = await import('./src/services/combineArtistData.js');
    const { generateTopGenres } = await import('./src/services/generateTopGenres.js');


    if (RELOAD_LASTFM_DATA) await fetchTopArtistsFromLastFM();
    if (RELOAD_LASTFM_DATA) await fetchArtistDetailsFromLastFM();
    if (RELOAD_MUSICBRAINZ_DATA) await fetchArtistsFromMusicBrainz();
    if (RELOAD_SPOTIFY_DATA) await fetchAndSaveSpotifyArtists();
    if (RELOAD_COMBINE_DATA) await combineLastfmAndSpotifyData();
    if (GENERATE_TOP_GENRES) await generateTopGenres();
    if (EXPORT_TO_NEO4J) {
        const { exportTopArtistsToNeo4j } = await import('./src/services/neo4jExportService.js');
        const { exportTopGenresToNeo4j } = await import('./src/services/exportTopGenresToNeo4j.js');
        await exportTopArtistsToNeo4j();
        await exportTopGenresToNeo4j();
    }
}

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
