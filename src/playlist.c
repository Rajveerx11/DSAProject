/*
 * playlist.c - the doubly linked list behind the music player.
 *
 * Each song is a SongNode with a `prev` and a `next` pointer.
 * The Playlist keeps three extra pointers:
 *     head    -> first song
 *     tail    -> last song
 *     current -> song that is "playing"
 *
 *     NULL <- [A] <-> [B] <-> [C] -> NULL
 *             head   current  tail
 *
 * Every pointer change goes through the small set_* helpers below.
 * They do the assignment and, if the web UI is watching (observer),
 * report it so the browser can animate the arrows moving.
 */
#include "playlist.h"

#include <stdlib.h>
#include <string.h>

/* ---------- Reporting changes to the web UI (optional) ---------- */

static uint32_t node_id(const SongNode *node) { return node ? node->id : 0; } /* 0 means NULL */

static void report(const Playlist *list, const PlaylistEvent *event)
{
    if (list->observer) list->observer(list->observer_context, list, event);
}

/* Report "node was allocated / visited / freed". */
static void report_node(const Playlist *list, PlaylistEventKind kind, const SongNode *node)
{
    PlaylistEvent event = {.kind = kind, .id = node->id};
    if (kind == PLAYLIST_ALLOCATE) {
        strcpy(event.title, node->title);
        strcpy(event.artist, node->artist);
    }
    report(list, &event);
}

/* Do `*slot = target` and report it (even when the value does not change). */
static void set_pointer(Playlist *list, SongNode *owner, PlaylistPointer field,
                        SongNode **slot, SongNode *target)
{
    PlaylistEvent event = {.kind = PLAYLIST_POINTER, .field = field,
                           .id = node_id(owner), .from = node_id(*slot), .to = node_id(target)};
    *slot = target;
    report(list, &event);
}

static void set_next(Playlist *list, SongNode *node, SongNode *target)
{
    set_pointer(list, node, POINTER_NEXT, &node->next, target);
}
static void set_prev(Playlist *list, SongNode *node, SongNode *target)
{
    set_pointer(list, node, POINTER_PREV, &node->prev, target);
}
static void set_head(Playlist *list, SongNode *target)
{
    set_pointer(list, NULL, POINTER_HEAD, &list->head, target);
}
static void set_tail(Playlist *list, SongNode *target)
{
    set_pointer(list, NULL, POINTER_TAIL, &list->tail, target);
}
static void set_current(Playlist *list, SongNode *target)
{
    set_pointer(list, NULL, POINTER_CURRENT, &list->current, target);
}

/* ---------- Linked list operations ---------- */

/* Insert at the end. O(1) because we keep a tail pointer. */
SongNode *playlist_add(Playlist *list, uint32_t id, const char *title,
                       const char *artist)
{
    char clean_title[SONG_TEXT_BYTES + 1], clean_artist[SONG_TEXT_BYTES + 1];
    if (id == 0 || list->size >= SONG_LIMIT) return NULL;
    if (!song_text(clean_title, title) || !song_text(clean_artist, artist)) return NULL;

    SongNode *node = calloc(1, sizeof(*node)); /* prev and next start as NULL */
    if (!node) return NULL;
    node->id = id;
    strcpy(node->title, clean_title);
    strcpy(node->artist, clean_artist);
    report_node(list, PLAYLIST_ALLOCATE, node);

    set_prev(list, node, list->tail);        /* new node points back to old tail */
    if (list->tail)
        set_next(list, list->tail, node);    /* old tail points forward to new node */
    else
        set_head(list, node);                /* list was empty: node is also head */
    set_tail(list, node);
    if (!list->current) set_current(list, node); /* first song becomes "playing" */
    list->size++;
    return node;
}

/* Linear search from head. O(n). */
SongNode *playlist_find(const Playlist *list, uint32_t id)
{
    for (SongNode *node = list->head; node; node = node->next) {
        report_node(list, PLAYLIST_VISIT, node);
        if (node->id == id) return node;
    }
    return NULL;
}

bool playlist_delete(Playlist *list, uint32_t id)
{
    SongNode *node = playlist_find(list, id);
    if (!node) return false;
    playlist_delete_node(list, node);
    return true;
}

/* Unlink a node by joining its neighbours, then free it. O(1). */
void playlist_delete_node(Playlist *list, SongNode *node)
{
    if (list->current == node)                /* playing song removed: move to a neighbour */
        set_current(list, node->next ? node->next : node->prev);

    if (node->prev)
        set_next(list, node->prev, node->next); /* left neighbour skips over node */
    else
        set_head(list, node->next);             /* node was head */

    if (node->next)
        set_prev(list, node->next, node->prev); /* right neighbour skips over node */
    else
        set_tail(list, node->prev);             /* node was tail */

    list->size--;
    report_node(list, PLAYLIST_FREE, node);
    free(node);
}

bool playlist_select(Playlist *list, uint32_t id)
{
    SongNode *node = playlist_find(list, id);
    if (!node) return false;
    playlist_select_node(list, node);
    return true;
}

void playlist_select_node(Playlist *list, SongNode *node)
{
    set_current(list, node);
}

/* Next / previous song: follow current->next or current->prev. O(1). */
bool playlist_move(Playlist *list, bool forward)
{
    if (!list->current) return false;
    SongNode *target = forward ? list->current->next : list->current->prev;
    if (!target) return false; /* already at the end / start */
    set_current(list, target);
    return true;
}

/* Reverse in place: swap prev and next on every node, then swap head and tail. O(n). */
void playlist_reverse(Playlist *list)
{
    SongNode *node = list->head;
    while (node) {
        SongNode *after = node->next;     /* remember the way forward before swapping */
        set_next(list, node, node->prev);
        set_prev(list, node, after);
        node = after;
    }
    SongNode *old_head = list->head;
    set_head(list, list->tail);
    set_tail(list, old_head);
}

/* Append all of `source` to the end of `destination`, leaving `source` empty. O(1). */
bool playlist_merge(Playlist *destination, Playlist *source)
{
    if (destination == source || destination->size + source->size > SONG_LIMIT)
        return false;
    if (!source->head) return true; /* nothing to move */

    if (destination->tail) {
        set_next(destination, destination->tail, source->head); /* join the two chains */
        set_prev(source, source->head, destination->tail);
    } else {
        set_head(destination, source->head);   /* destination was empty */
        set_current(destination, source->current);
    }
    set_tail(destination, source->tail);
    destination->size += source->size;

    set_head(source, NULL);
    set_tail(source, NULL);
    set_current(source, NULL);
    source->size = 0;
    return true;
}

/* Free every node. O(n). */
void playlist_clear(Playlist *list)
{
    SongNode *node = list->head;
    set_head(list, NULL);
    set_tail(list, NULL);
    set_current(list, NULL);
    while (node) {
        SongNode *after = node->next;
        report_node(list, PLAYLIST_FREE, node);
        free(node);
        node = after;
    }
    list->size = 0;
}

/* ---------- Input cleaning (not linked list logic) ---------- */

/* True when bytes[0..length) is valid UTF-8 with no control characters. */
static bool valid_utf8(const unsigned char *bytes, size_t length)
{
    for (size_t i = 0; i < length;) {
        uint32_t cp = bytes[i++];
        unsigned extra = 0;   /* continuation bytes that follow */
        uint32_t minimum = 0; /* smallest code point allowed for this length (no overlong forms) */
        if (cp >= 0xc2 && cp <= 0xdf) {
            extra = 1; minimum = 0x80; cp &= 0x1f;
        } else if (cp >= 0xe0 && cp <= 0xef) {
            extra = 2; minimum = 0x800; cp &= 0x0f;
        } else if (cp >= 0xf0 && cp <= 0xf4) {
            extra = 3; minimum = 0x10000; cp &= 7;
        } else if (cp >= 0x80) {
            return false;
        }
        if (extra > length - i) return false;
        for (unsigned j = 0; j < extra; j++) {
            if ((bytes[i] & 0xc0) != 0x80) return false;
            cp = (cp << 6) | (bytes[i++] & 0x3f);
        }
        if (cp < minimum || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)
            || cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return false;
    }
    return true;
}

/* Trim spaces, then accept 1..SONG_TEXT_BYTES bytes of valid UTF-8. Never truncates. */
bool song_text(char out[SONG_TEXT_BYTES + 1], const char *input)
{
    while (*input == ' ') input++;
    size_t length = strlen(input);
    while (length && input[length - 1] == ' ') length--;
    if (length == 0 || length > SONG_TEXT_BYTES) return false;
    if (!valid_utf8((const unsigned char *)input, length)) return false;
    memcpy(out, input, length);
    out[length] = '\0';
    return true;
}
