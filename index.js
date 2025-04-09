import dotenv from 'dotenv';
import app from './src/app.js';
import {analyzeAndUpdateGenreMap} from "./src/services/genreAnalysisService.js";
import {exportGenresToMySQL} from "./src/services/mysqlExportGenresService.js";

const RELOAD_LASTFM_DATA = false;
const RELOAD_MUSICBRAINZ_DATA = false;
const RELOAD_SPOTIFY_DATA = false;
const ANALYZE_GENRES = false;
const RELOAD_COMBINE_DATA = false;
const EXPORT_DATA_TO_DATABASES = true;

dotenv.config();

const PORT = process.env.PORT || 3000;

if (
    RELOAD_LASTFM_DATA ||
    RELOAD_MUSICBRAINZ_DATA ||
    RELOAD_SPOTIFY_DATA ||
    RELOAD_COMBINE_DATA ||
    ANALYZE_GENRES ||
    EXPORT_DATA_TO_DATABASES
) {

    if (RELOAD_LASTFM_DATA) {
        const { fetchTopArtistsFromLastFM, fetchArtistDetailsFromLastFM } = await import('./src/services/lastfmService.js');
        await fetchTopArtistsFromLastFM();
        await fetchArtistDetailsFromLastFM();
    }

    if (RELOAD_MUSICBRAINZ_DATA) {
        const { fetchArtistsFromMusicBrainz } = await import('./src/services/musicBrainzService.js');
        await fetchArtistsFromMusicBrainz();
    }

    if (RELOAD_SPOTIFY_DATA) {
        const { fetchAndSaveSpotifyArtists } = await import('./src/services/spotifyService.js');
        await fetchAndSaveSpotifyArtists();
    }

    if (ANALYZE_GENRES) {
        const { analyzeAndUpdateGenreMap } = await import('./src/services/genreAnalysisService.js');
        await analyzeAndUpdateGenreMap();
    }

    if (RELOAD_COMBINE_DATA) {
        const { combineAllArtistData } = await import('./src/services/combineArtistData.js');
        await combineAllArtistData();
    }

    if (EXPORT_DATA_TO_DATABASES) {
        const { exportTopArtistsToNeo4j } = await import('./src/services/neo4jExportArtistsService.js');
        const { exportGenresToMySQL } = await import('./src/services/mysqlExportGenresService.js');
        await exportTopArtistsToNeo4j();
        await exportGenresToMySQL();
    }
}

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
