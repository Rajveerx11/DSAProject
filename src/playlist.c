#include "playlist.h"

#include <stdlib.h>
#include <string.h>

static uint32_t node_id(const SongNode *node) { return node ? node->id : 0; }

static void emit(Playlist *list, PlaylistEventKind kind, const SongNode *node)
{
    PlaylistEvent event = {.kind = kind, .id = node_id(node)};
    if (kind == PLAYLIST_ALLOCATE) {
        strcpy(event.title, node->title);
        strcpy(event.artist, node->artist);
    }
    list->observer(list->observer_context, list, &event);
}

/* Disabled tracing costs only the branch; record the actual assignment, even a no-op. */
#define ASSIGN(list, owner, field_name, slot, target) do { \
    if ((list)->observer) { \
        PlaylistEvent event = {.kind = PLAYLIST_POINTER, .field = (field_name), \
            .id = node_id(owner), .from = node_id(slot)}; \
        (slot) = (target); \
        event.to = node_id(slot); \
        (list)->observer((list)->observer_context, (list), &event); \
    } else { (slot) = (target); } \
} while (0)

bool song_text(char out[SONG_TEXT_BYTES + 1], const char *input)
{
    const unsigned char *start = (const unsigned char *)input;
    while (*start == ' ') start++;
    size_t length = strlen((const char *)start);
    while (length && start[length - 1] == ' ') length--;
    if (!length || length > SONG_TEXT_BYTES) return false;
    for (size_t i = 0; i < length;) {
        uint32_t cp = start[i++];
        unsigned extra = 0;
        uint32_t minimum = 0;
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
            if ((start[i] & 0xc0) != 0x80) return false;
            cp = (cp << 6) | (start[i++] & 0x3f);
        }
        if (cp < minimum || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)
            || cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return false;
    }
    memcpy(out, start, length);
    out[length] = '\0';
    return true;
}

SongNode *playlist_add(Playlist *list, uint32_t id, const char *title,
                       const char *artist)
{
    char clean_title[SONG_TEXT_BYTES + 1], clean_artist[SONG_TEXT_BYTES + 1];
    if (!id || list->size >= SONG_LIMIT || !song_text(clean_title, title)
        || !song_text(clean_artist, artist)) return NULL;
    SongNode *node = calloc(1, sizeof(*node));
    if (!node) return NULL;
    node->id = id;
    strcpy(node->title, clean_title);
    strcpy(node->artist, clean_artist);
    if (list->observer) emit(list, PLAYLIST_ALLOCATE, node);
    ASSIGN(list, node, POINTER_PREV, node->prev, list->tail);
    if (list->tail) ASSIGN(list, list->tail, POINTER_NEXT, list->tail->next, node);
    else ASSIGN(list, NULL, POINTER_HEAD, list->head, node);
    ASSIGN(list, NULL, POINTER_TAIL, list->tail, node);
    if (!list->current) ASSIGN(list, NULL, POINTER_CURRENT, list->current, node);
    list->size++;
    return node;
}

SongNode *playlist_find(const Playlist *list, uint32_t id)
{
    for (SongNode *node = list->head; node; node = node->next) {
        if (list->observer) {
            PlaylistEvent event = {.kind = PLAYLIST_VISIT, .id = node->id};
            list->observer(list->observer_context, list, &event);
        }
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

void playlist_delete_node(Playlist *list, SongNode *node)
{
    if (list->current == node)
        ASSIGN(list, NULL, POINTER_CURRENT, list->current, node->next ? node->next : node->prev);
    if (node->prev) ASSIGN(list, node->prev, POINTER_NEXT, node->prev->next, node->next);
    else ASSIGN(list, NULL, POINTER_HEAD, list->head, node->next);
    if (node->next) ASSIGN(list, node->next, POINTER_PREV, node->next->prev, node->prev);
    else ASSIGN(list, NULL, POINTER_TAIL, list->tail, node->prev);
    list->size--;
    if (list->observer) emit(list, PLAYLIST_FREE, node);
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
    ASSIGN(list, NULL, POINTER_CURRENT, list->current, node);
}

bool playlist_move(Playlist *list, bool forward)
{
    if (!list->current) return false;
    SongNode *next = forward ? list->current->next : list->current->prev;
    if (!next) return false;
    ASSIGN(list, NULL, POINTER_CURRENT, list->current, next);
    return true;
}

void playlist_reverse(Playlist *list)
{
    SongNode *node = list->head;
    while (node) {
        SongNode *next = node->next;
        ASSIGN(list, node, POINTER_NEXT, node->next, node->prev);
        ASSIGN(list, node, POINTER_PREV, node->prev, next);
        node = next;
    }
    SongNode *head = list->head;
    ASSIGN(list, NULL, POINTER_HEAD, list->head, list->tail);
    ASSIGN(list, NULL, POINTER_TAIL, list->tail, head);
}

bool playlist_merge(Playlist *destination, Playlist *source)
{
    if (destination == source || destination->size + source->size > SONG_LIMIT)
        return false;
    if (!source->head) return true;
    if (destination->tail) {
        ASSIGN(destination, destination->tail, POINTER_NEXT, destination->tail->next, source->head);
        ASSIGN(source, source->head, POINTER_PREV, source->head->prev, destination->tail);
    } else {
        ASSIGN(destination, NULL, POINTER_HEAD, destination->head, source->head);
        ASSIGN(destination, NULL, POINTER_CURRENT, destination->current, source->current);
    }
    ASSIGN(destination, NULL, POINTER_TAIL, destination->tail, source->tail);
    destination->size += source->size;
    ASSIGN(source, NULL, POINTER_HEAD, source->head, NULL);
    ASSIGN(source, NULL, POINTER_TAIL, source->tail, NULL);
    ASSIGN(source, NULL, POINTER_CURRENT, source->current, NULL);
    source->size = 0;
    return true;
}

void playlist_clear(Playlist *list)
{
    SongNode *node = list->head;
    ASSIGN(list, NULL, POINTER_HEAD, list->head, NULL);
    ASSIGN(list, NULL, POINTER_TAIL, list->tail, NULL);
    ASSIGN(list, NULL, POINTER_CURRENT, list->current, NULL);
    while (node) {
        SongNode *next = node->next;
        if (list->observer) emit(list, PLAYLIST_FREE, node);
        free(node);
        node = next;
    }
    list->size = 0;
}
