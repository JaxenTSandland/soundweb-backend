async function fetchTopAlbums({ name, mbid }) {
    const API_KEY = process.env.LASTFM_API_KEY;
    const baseUrl = "https://ws.audioscrobbler.com/2.0/";

    const params = new URLSearchParams({
        method: "artist.gettopalbums",
        api_key: API_KEY,
        format: "json",
        limit: "5",
    });

    if (mbid) params.append("mbid", mbid);
    else if (name) params.append("artist", name);
    else throw new Error("Artist name or MBID required");

    const url = `${baseUrl}?${params.toString()}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch top albums from Last.fm: ${res.status}`);
    const json = await res.json();

    if (!json.topalbums?.album) return [];

    return json.topalbums.album.map(album => ({
        name: album.name,
        mbid: album.mbid || null,
        url: album.url,
        listeners: Number(album.listeners) || 0,
        image: album.image?.find(img => img.size === 'large')?.["#text"] || null
    }));
}

async function fetchArtistBio({ name, mbid }) {
    const API_KEY = process.env.LASTFM_API_KEY;
    const baseUrl = "https://ws.audioscrobbler.com/2.0/";

    const params = new URLSearchParams({
        method: "artist.getinfo",
        api_key: API_KEY,
        format: "json",
        lang: "en",
        autocorrect: "1"
    });

    if (mbid) params.append("mbid", mbid);
    else if (name) params.append("artist", name);
    else throw new Error("Artist name or MBID required");

    const url = `${baseUrl}?${params.toString()}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch artist bio: ${res.status}`);

    const data = await res.json();
    return {
        name: data.artist?.name || null,
        listeners: data.artist?.stats?.listeners || null,
        plays: data.artist?.stats?.playcount || null,
        summary: data.artist?.bio?.summary || null,
        content: data.artist?.bio?.content || null,
        url: data.artist?.url || null,
        images: data.artist?.image || []
    };
}

export { fetchTopAlbums, fetchArtistBio };
