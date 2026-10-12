#include "playlist.h"

#include <stdlib.h>
#include <string.h>

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
    node->prev = list->tail;
    if (list->tail) list->tail->next = node;
    else list->head = node;
    list->tail = node;
    if (!list->current) list->current = node;
    list->size++;
    return node;
}

SongNode *playlist_find(const Playlist *list, uint32_t id)
{
    for (SongNode *node = list->head; node; node = node->next)
        if (node->id == id) return node;
    return NULL;
}

bool playlist_delete(Playlist *list, uint32_t id)
{
    SongNode *node = playlist_find(list, id);
    if (!node) return false;
    if (list->current == node)
        list->current = node->next ? node->next : node->prev;
    if (node->prev) node->prev->next = node->next;
    else list->head = node->next;
    if (node->next) node->next->prev = node->prev;
    else list->tail = node->prev;
    list->size--;
    free(node);
    return true;
}

bool playlist_select(Playlist *list, uint32_t id)
{
    SongNode *node = playlist_find(list, id);
    if (!node) return false;
    list->current = node;
    return true;
}

bool playlist_move(Playlist *list, bool forward)
{
    if (!list->current) return false;
    SongNode *next = forward ? list->current->next : list->current->prev;
    if (!next) return false;
    list->current = next;
    return true;
}

void playlist_reverse(Playlist *list)
{
    SongNode *node = list->head;
    while (node) {
        SongNode *next = node->next;
        node->next = node->prev;
        node->prev = next;
        node = next;
    }
    SongNode *head = list->head;
    list->head = list->tail;
    list->tail = head;
}

bool playlist_merge(Playlist *destination, Playlist *source)
{
    if (destination == source || destination->size + source->size > SONG_LIMIT)
        return false;
    if (!source->head) return true;
    if (destination->tail) {
        destination->tail->next = source->head;
        source->head->prev = destination->tail;
    } else {
        destination->head = source->head;
        destination->current = source->current;
    }
    destination->tail = source->tail;
    destination->size += source->size;
    *source = (Playlist){0};
    return true;
}

void playlist_clear(Playlist *list)
{
    SongNode *node = list->head;
    while (node) {
        SongNode *next = node->next;
        free(node);
        node = next;
    }
    *list = (Playlist){0};
}
