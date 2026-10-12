#include "playlist.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static void valid(const Playlist *list)
{
    size_t forward = 0, backward = 0;
    bool current = false;
    const SongNode *previous = NULL;
    for (const SongNode *node = list->head; node; node = node->next) {
        assert(++forward <= SONG_LIMIT);
        assert(node->prev == previous);
        if (previous) assert(previous->next == node);
        assert(node->id > 0);
        if (node == list->current) current = true;
        previous = node;
    }
    assert(previous == list->tail && forward == list->size);
    const SongNode *next = NULL;
    for (const SongNode *node = list->tail; node; node = node->prev) {
        assert(++backward <= SONG_LIMIT);
        assert(node->next == next);
        if (next) assert(next->prev == node);
        next = node;
    }
    assert(next == list->head && backward == forward);
    if (list->size) {
        assert(list->head->prev == NULL && list->tail->next == NULL && current);
    } else {
        assert(!list->head && !list->tail && !list->current);
    }
}

static SongNode *add(Playlist *list, uint32_t id)
{
    SongNode *node = playlist_add(list, id, " Test song ", " Demo tones ");
    assert(node && !strcmp(node->title, "Test song") && !strcmp(node->artist, "Demo tones"));
    valid(list);
    return node;
}

static void removals(void)
{
    Playlist list = {0};
    valid(&list);
    assert(!playlist_delete(&list, 1));
    assert(!playlist_select(&list, 1));
    assert(!playlist_move(&list, true));
    assert(!playlist_move(&list, false));
    playlist_reverse(&list); valid(&list);
    SongNode *one = add(&list, 1);
    assert(list.head == one && list.tail == one && list.current == one);
    assert(!playlist_move(&list, false) && !playlist_move(&list, true));
    playlist_reverse(&list); valid(&list);
    assert(playlist_delete(&list, 1)); valid(&list);
    one = add(&list, 2);
    SongNode *middle = add(&list, 3);
    SongNode *tail = add(&list, 4);
    assert(playlist_delete(&list, 3)); valid(&list);
    assert(one->next == tail && tail->prev == one && list.current == one);
    middle = add(&list, 5);
    assert(playlist_select(&list, 4)); valid(&list);
    assert(playlist_delete(&list, 4)); valid(&list);
    assert(list.current == middle);
    assert(playlist_delete(&list, 5)); valid(&list);
    assert(list.current == one && list.tail == one);
    tail = add(&list, 6);
    assert(playlist_delete(&list, 2)); valid(&list);
    assert(list.head == tail && list.current == tail);
    playlist_clear(&list); valid(&list);
    playlist_clear(&list); valid(&list);
}

static void reverse_and_move(void)
{
    Playlist list = {0};
    SongNode *one = add(&list, 1), *two = add(&list, 2), *three = add(&list, 3);
    assert(!playlist_move(&list, false));
    assert(playlist_move(&list, true) && list.current == two); valid(&list);
    assert(playlist_move(&list, true) && list.current == three); valid(&list);
    assert(!playlist_move(&list, true));
    assert(playlist_move(&list, false) && list.current == two); valid(&list);
    playlist_reverse(&list); valid(&list);
    assert(list.head == three && list.tail == one && list.current == two);
    assert(three->next == two && two->next == one);
    playlist_reverse(&list); valid(&list);
    assert(list.head == one && list.tail == three && list.current == two);
    assert(one->next == two && two->next == three);
    playlist_clear(&list); valid(&list);
}

static void merges(void)
{
    Playlist a = {0}, b = {0};
    assert(playlist_merge(&a, &b)); valid(&a); valid(&b);
    assert(!playlist_merge(&a, &a)); valid(&a);
    SongNode *one = add(&a, 1);
    assert(playlist_merge(&a, &b)); valid(&a); valid(&b);
    assert(a.current == one);
    SongNode *two = add(&b, 2), *three = add(&b, 3);
    assert(playlist_select(&b, 3));
    assert(playlist_merge(&a, &b)); valid(&a); valid(&b);
    assert(a.current == one && a.tail == three && one->next == two && two->prev == one);
    assert(!playlist_merge(&a, &a)); valid(&a);
    assert(playlist_select(&a, 2));
    assert(playlist_merge(&b, &a)); valid(&a); valid(&b);
    assert(b.head == one && b.tail == three && b.current == two);
    playlist_clear(&a); playlist_clear(&b); valid(&a); valid(&b);
    for (uint32_t i = 1; i <= SONG_LIMIT; i++) add(&a, i);
    assert(!playlist_add(&a, 201, "song", "artist")); valid(&a);
    add(&b, 201);
    assert(!playlist_merge(&a, &b)); valid(&a); valid(&b);
    playlist_clear(&a); playlist_clear(&b); valid(&a); valid(&b);
}

static void text_bounds(void)
{
    char clean[SONG_TEXT_BYTES + 1], text[140];
    assert(song_text(clean, "  Caf\xc3\xa9 \xf0\x9f\x8e\xb5  "));
    assert(!strcmp(clean, "Caf\xc3\xa9 \xf0\x9f\x8e\xb5"));
    memset(text, 'x', 127); text[127] = '\0';
    assert(song_text(clean, text) && strlen(clean) == 127);
    text[127] = 'x'; text[128] = '\0'; assert(!song_text(clean, text));
    for (size_t i = 0; i < 63; i++) { text[i * 2] = '\xc3'; text[i * 2 + 1] = '\xa9'; }
    text[126] = 'x'; text[127] = '\0'; assert(song_text(clean, text));
    text[126] = '\xc3'; text[127] = '\xa9'; text[128] = '\0'; assert(!song_text(clean, text));
    assert(!song_text(clean, "")); assert(!song_text(clean, "    "));
    assert(!song_text(clean, "a\nb")); assert(!song_text(clean, "a\tb"));
    assert(!song_text(clean, "\x7f")); assert(!song_text(clean, "\xc2\x85"));
    assert(!song_text(clean, "\xc0\xaf")); assert(!song_text(clean, "\xe0\x80\xaf"));
    assert(!song_text(clean, "\xed\xa0\x80")); assert(!song_text(clean, "\xf4\x90\x80\x80"));
    assert(!song_text(clean, "\xf0\x9f")); assert(!song_text(clean, "\x80"));
    Playlist list = {0};
    assert(!playlist_add(&list, 0, "song", "artist"));
    assert(!playlist_add(&list, 1, "  ", "artist"));
    assert(!playlist_add(&list, 1, "song", "\xff")); valid(&list);
    playlist_clear(&list); valid(&list);
}

typedef struct {
    SongNode *nodes[3];
    PlaylistEvent events[32];
    size_t count;
} Observation;

static void observe(void *context, const Playlist *list, const PlaylistEvent *event)
{
    Observation *observation = context;
    assert(observation->count < 32);
    observation->events[observation->count++] = *event;
    if (event->kind == PLAYLIST_POINTER) {
        const SongNode *target = NULL;
        if (!event->id) {
            if (event->field == POINTER_HEAD) target = list->head;
            else if (event->field == POINTER_TAIL) target = list->tail;
            else { assert(event->field == POINTER_CURRENT); target = list->current; }
        } else {
            SongNode *owner = NULL;
            for (size_t i = 0; i < 3; i++)
                if (observation->nodes[i] && observation->nodes[i]->id == event->id)
                    owner = observation->nodes[i];
            assert(owner);
            assert(event->field == POINTER_PREV || event->field == POINTER_NEXT);
            target = event->field == POINTER_PREV ? owner->prev : owner->next;
        }
        /* Callback is at the real assignment, not generated from final state. */
        assert(event->to == (target ? target->id : 0));
    } else if (event->kind == PLAYLIST_FREE) {
        bool live = false;
        for (size_t i = 0; i < 3; i++) {
            SongNode *node = observation->nodes[i];
            if (node && node->id == event->id) {
                assert(list->current != node);
                observation->nodes[i] = NULL;
                live = true;
            }
        }
        assert(live); /* Free callback ran while ID was still readable. */
    }
}

static void observers(void)
{
    Playlist list = {0};
    Observation observation = {0};
    for (uint32_t i = 0; i < 3; i++) observation.nodes[i] = add(&list, i + 1);
    assert(!list.observer && !list.observer_context);
    list.observer = observe; list.observer_context = &observation;
    assert(playlist_select(&list, 2));
    assert(observation.count == 3);
    assert(observation.events[0].kind == PLAYLIST_VISIT && observation.events[0].id == 1);
    assert(observation.events[1].kind == PLAYLIST_VISIT && observation.events[1].id == 2);
    assert(observation.events[2].kind == PLAYLIST_POINTER);
    observation.count = 0;
    playlist_reverse(&list); valid(&list);
    assert(observation.count == 8);
    assert(playlist_delete(&list, 2)); valid(&list);
    assert(observation.count == 14);
    assert(observation.events[8].kind == PLAYLIST_VISIT && observation.events[8].id == 3);
    assert(observation.events[9].kind == PLAYLIST_VISIT && observation.events[9].id == 2);
    assert(observation.events[13].kind == PLAYLIST_FREE && observation.events[13].id == 2);
    playlist_clear(&list); valid(&list);
    list.observer = NULL; list.observer_context = NULL;
}

int main(void)
{
    removals(); reverse_and_move(); merges(); text_bounds(); observers();
    puts("native: PASS (removals, navigation, reverse, merge, UTF-8, bounds, invariants, cleanup, synchronous observers)");
    return 0;
}
