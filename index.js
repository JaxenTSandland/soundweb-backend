import dotenv from 'dotenv';
import app from './src/app.js';

const RELOAD_LASTFM_DATA = false;
const RELOAD_MUSICBRAINZ_DATA = false;
const RELOAD_SPOTIFY_DATA = false;
const RELOAD_COMBINE_DATA = true;
const GENERATE_TOP_GENRES = true;
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

    if (RELOAD_COMBINE_DATA) {
        const { combineLastfmAndSpotifyData } = await import('./src/services/combineArtistData.js');
        await combineLastfmAndSpotifyData();
    }

    if (GENERATE_TOP_GENRES) {
        const { generateTopGenres } = await import('./src/services/generateTopGenres.js');
        await generateTopGenres();
    }

    if (EXPORT_TO_NEO4J) {
        const { exportTopArtistsToNeo4j } = await import('./src/services/neo4jExportArtistsService.js');
        const { exportTopGenresToNeo4j } = await import('./src/services/neo4jExportGenresService.js');
        await exportTopArtistsToNeo4j();
        await exportTopGenresToNeo4j();
    }
}

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
