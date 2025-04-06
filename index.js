import dotenv from 'dotenv';
import app from './src/app.js';
import {fetchArtistsFromMusicBrainz} from "./src/services/musicBrainzService.js";

const RELOAD_LASTFM_DATA = false;
const RELOAD_MUSICBRAINZ_DATA = false;
const RELOAD_SPOTIFY_DATA = false;
const RELOAD_COMBINE_DATA = true;

dotenv.config();

const PORT = process.env.PORT || 3000;

if (RELOAD_LASTFM_DATA || RELOAD_SPOTIFY_DATA || RELOAD_COMBINE_DATA) {
    const { fetchTopArtistsFromLastFM, fetchArtistDetailsFromLastFM } = await import('./src/services/lastfmService.js');
    const { fetchArtistsFromMusicBrainz } = await import('./src/services/musicBrainzService.js');
    const { fetchAndSaveSpotifyArtists } = await import('./src/services/spotifyService.js');
    const { combineLastfmAndSpotifyData } = await import('./src/services/combineArtistData.js');

    if (RELOAD_LASTFM_DATA) await fetchTopArtistsFromLastFM();
    if (RELOAD_LASTFM_DATA) await fetchArtistDetailsFromLastFM();
    if (RELOAD_MUSICBRAINZ_DATA) await fetchArtistsFromMusicBrainz();
    if (RELOAD_SPOTIFY_DATA) await fetchAndSaveSpotifyArtists();
    if (RELOAD_COMBINE_DATA) await combineLastfmAndSpotifyData();
}

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
