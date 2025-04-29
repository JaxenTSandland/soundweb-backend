export class ArtistNode {
    constructor({
                    id,
                    name,
                    popularity = 0,
                    spotifyId = null,
                    spotifyUrl = null,
                    lastfmMBID = null,
                    imageUrl = null,
                    genres = [],
                    x = null,
                    y = null,
                    color = null,
                    userTags = [],
                    relatedArtists = [],
                    rank = null
                }) {
        this.id = id;
        this.name = name;
        this.popularity = popularity;
        this.spotifyId = spotifyId;
        this.spotifyUrl = spotifyUrl;
        this.lastfmMBID = lastfmMBID;
        this.imageUrl = imageUrl;
        this.genres = genres;
        this.x = x;
        this.y = y;
        this.color = color;
        this.userTags = userTags;
        this.relatedArtists = relatedArtists;
        this.rank = rank;
    }

    toDict() {
        return {
            id: this.id,
            name: this.name,
            popularity: this.popularity,
            spotifyId: this.spotifyId,
            spotifyUrl: this.spotifyUrl,
            lastfmMBID: this.lastfmMBID,
            imageUrl: this.imageUrl,
            genres: this.genres,
            x: this.x,
            y: this.y,
            color: this.color,
            userTags: this.userTags,
            relatedArtists: this.relatedArtists,
            rank: this.rank
        };
    }
}