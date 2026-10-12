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

typedef enum { PLAYLIST_ALLOCATE, PLAYLIST_VISIT, PLAYLIST_POINTER, PLAYLIST_FREE } PlaylistEventKind;
typedef enum { POINTER_PREV, POINTER_NEXT, POINTER_HEAD, POINTER_TAIL, POINTER_CURRENT } PlaylistPointer;

/* Events own IDs/metadata, never node addresses (including after a free). */
typedef struct {
    PlaylistEventKind kind;
    PlaylistPointer field;
    uint32_t id, from, to; /* zero denotes NULL */
    char title[SONG_TEXT_BYTES + 1], artist[SONG_TEXT_BYTES + 1];
} PlaylistEvent;

typedef struct Playlist Playlist;
/* Synchronous, read-only callback; do not mutate/reenter the list. */
typedef void (*PlaylistObserver)(void *context, const Playlist *list,
                                 const PlaylistEvent *event);
struct Playlist {
    SongNode *head, *tail, *current;
    size_t size;
    PlaylistObserver observer; /* optional, NULL by default */
    void *observer_context;
};

/* Validate UTF-8, trim ASCII spaces, reject control code points; never truncate. */
bool song_text(char out[SONG_TEXT_BYTES + 1], const char *input);
/* Caller supplies a fresh process-wide ID; nodes are owned by their playlist. */
SongNode *playlist_add(Playlist *list, uint32_t id, const char *title,
                       const char *artist);
SongNode *playlist_find(const Playlist *list, uint32_t id);
bool playlist_delete(Playlist *list, uint32_t id);
bool playlist_select(Playlist *list, uint32_t id);
/* Node must belong to list; reuse a successful find without another traversal. */
void playlist_delete_node(Playlist *list, SongNode *node);
void playlist_select_node(Playlist *list, SongNode *node);
bool playlist_move(Playlist *list, bool forward);
void playlist_reverse(Playlist *list);
bool playlist_merge(Playlist *destination, Playlist *source);
void playlist_clear(Playlist *list);

#endif
