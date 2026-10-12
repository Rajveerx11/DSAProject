#ifndef PLAYLIST_H
#define PLAYLIST_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define SONG_TEXT_BYTES 127
#define SONG_LIMIT 200

typedef struct SongNode {
    uint32_t id;
    char title[SONG_TEXT_BYTES + 1];
    char artist[SONG_TEXT_BYTES + 1];
    struct SongNode *prev, *next;
} SongNode;

typedef struct {
    SongNode *head, *tail, *current;
    size_t size;
} Playlist;

/* Validate UTF-8, trim ASCII spaces, reject control code points; never truncate. */
bool song_text(char out[SONG_TEXT_BYTES + 1], const char *input);
/* Caller supplies a fresh process-wide ID; nodes are owned by their playlist. */
SongNode *playlist_add(Playlist *list, uint32_t id, const char *title,
                       const char *artist);
SongNode *playlist_find(const Playlist *list, uint32_t id);
bool playlist_delete(Playlist *list, uint32_t id);
bool playlist_select(Playlist *list, uint32_t id);
bool playlist_move(Playlist *list, bool forward);
void playlist_reverse(Playlist *list);
bool playlist_merge(Playlist *destination, Playlist *source);
void playlist_clear(Playlist *list);

#endif
