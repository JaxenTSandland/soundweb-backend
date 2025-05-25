async function refreshSpotifyAccessToken(refreshToken) {
    const response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: process.env.SPOTIFY_CLIENT_ID
        })
    });

    if (!response.ok) throw new Error("Failed to refresh token");
    const data = await response.json();
    return data.access_token;
}