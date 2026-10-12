#include "api.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

_Static_assert(TRACE_EVENT_LIMIT >= 3 * SONG_LIMIT + 32, "trace bound");
_Static_assert(RESPONSE_CAP >= 512 * 1024, "response bound");

/* Deterministic allocation failure without a production allocator abstraction. */
static int fail_after = -1;
void *__real_calloc(size_t count, size_t size);
void *__wrap_calloc(size_t count, size_t size)
{
    if (fail_after == 0) return NULL;
    if (fail_after > 0) fail_after--;
    return __real_calloc(count, size);
}

static App app;
static Response response, previous;

static uint32_t id(const SongNode *node) { return node ? node->id : 0; }

static int action(const char *form)
{
    char body[BODY_CAP + 1];
    assert(strlen(form) <= BODY_CAP);
    strcpy(body, form);
    int status = api_action(&app, body, &response);
    assert(!response.failed && response.length == strlen(response.data));
    assert(!app.lists[0].observer && !app.lists[0].observer_context);
    assert(!app.lists[1].observer && !app.lists[1].observer_context);
    return status;
}

static const PlaylistEvent *event(size_t index, PlaylistEventKind kind,
                                 unsigned playlist, uint32_t node)
{
    const OperationTrace *trace = &app.operation.trace;
    assert(index < trace->count);
    assert(trace->events[index].playlist == playlist);
    const PlaylistEvent *e = &trace->events[index].event;
    assert(e->kind == kind && e->id == node);
    return e;
}

static void pointer(size_t index, unsigned playlist, uint32_t node,
                    PlaylistPointer field, uint32_t from, uint32_t to)
{
    const PlaylistEvent *e = event(index, PLAYLIST_POINTER, playlist, node);
    assert(e->field == field && e->from == from && e->to == to);
}

static void before_matches_final(void)
{
    for (size_t i = 0; i < 2; i++) {
        const Playlist *list = &app.lists[i];
        const PlaylistSnapshot *copy = &app.operation.trace.before[i];
        assert(copy->head == id(list->head) && copy->tail == id(list->tail));
        assert(copy->current == id(list->current) && copy->size == list->size);
        size_t j = 0;
        for (const SongNode *n = list->head; n; n = n->next) {
            const SongSnapshot *s = &copy->nodes[j++];
            assert(s->id == n->id && s->prev == id(n->prev) && s->next == id(n->next));
            assert(!strcmp(s->title, n->title) && !strcmp(s->artist, n->artist));
        }
        assert(j == copy->size);
    }
}

/* Flat display projection: no list algorithms or traversal of intermediate links. */
typedef struct { SongSnapshot song; bool alive; } FrameNode;
static FrameNode *frame_node(FrameNode *nodes, size_t count, uint32_t node_id)
{
    for (size_t i = 0; i < count; i++)
        if (nodes[i].song.id == node_id && nodes[i].alive) return &nodes[i];
    assert(!"event references a nonexistent/freed node");
    return NULL;
}

static void parity(void)
{
    const OperationTrace *trace = &app.operation.trace;
    assert(!trace->truncated);
    FrameNode nodes[SONG_LIMIT + 1] = {0};
    size_t count = 0;
    uint32_t endpoints[2][3];
    for (size_t i = 0; i < 2; i++) {
        const PlaylistSnapshot *list = &trace->before[i];
        endpoints[i][0] = list->head; endpoints[i][1] = list->tail;
        endpoints[i][2] = list->current;
        for (size_t j = 0; j < list->size; j++) {
            assert(count < SONG_LIMIT + 1);
            nodes[count++] = (FrameNode){list->nodes[j], true};
        }
    }
    for (size_t i = 0; i < trace->count; i++) {
        const PlaylistEvent *e = &trace->events[i].event;
        unsigned list = trace->events[i].playlist;
        assert(list < 2);
        if (e->kind == PLAYLIST_ALLOCATE) {
            assert(count < SONG_LIMIT + 1);
            FrameNode *n = &nodes[count++];
            n->alive = true; n->song.id = e->id;
            strcpy(n->song.title, e->title); strcpy(n->song.artist, e->artist);
        } else if (e->kind == PLAYLIST_POINTER) {
            uint32_t *slot;
            if (e->id) {
                FrameNode *n = frame_node(nodes, count, e->id);
                assert(e->field == POINTER_PREV || e->field == POINTER_NEXT);
                slot = e->field == POINTER_PREV ? &n->song.prev : &n->song.next;
            } else {
                assert(e->field >= POINTER_HEAD && e->field <= POINTER_CURRENT);
                slot = &endpoints[list][e->field - POINTER_HEAD];
            }
            assert(*slot == e->from);
            if (e->to) (void)frame_node(nodes, count, e->to);
            *slot = e->to;
        } else {
            FrameNode *n = frame_node(nodes, count, e->id);
            if (e->kind == PLAYLIST_FREE) n->alive = false;
            else assert(e->kind == PLAYLIST_VISIT);
        }
    }
    size_t final_count = 0, alive = 0;
    for (size_t i = 0; i < 2; i++) {
        const Playlist *list = &app.lists[i];
        assert(endpoints[i][0] == id(list->head) && endpoints[i][1] == id(list->tail));
        assert(endpoints[i][2] == id(list->current));
        size_t size = 0;
        for (const SongNode *n = list->head; n; n = n->next) {
            assert(++size <= SONG_LIMIT);
            const SongSnapshot *s = &frame_node(nodes, count, n->id)->song;
            assert(s->prev == id(n->prev) && s->next == id(n->next));
            assert(!strcmp(s->title, n->title) && !strcmp(s->artist, n->artist));
        }
        assert(size == list->size);
        final_count += size;
    }
    for (size_t i = 0; i < count; i++) alive += nodes[i].alive;
    assert(alive == final_count);
}

static void success(const char *form)
{
    /* Compare serialized pre-state with trace.before using the shared exact shape. */
    api_state(&app, &previous);
    const char *start = strstr(previous.data, "\"playlists\":") + strlen("\"playlists\":");
    const char *end = strstr(start, ",\"operation\":");
    size_t length = (size_t)(end - start);
    assert(action(form) == 200);
    const char *before = strstr(response.data, "\"before\":") + strlen("\"before\":");
    assert(!strncmp(start, before, length) && before[length] == ',');
    parity();
}

static void rejected(const char *form, int status)
{
    api_state(&app, &previous);
    uint64_t next_id = app.next_id;
    assert(action(form) == status && app.next_id == next_id);
    api_state(&app, &response);
    assert(previous.length == response.length && !strcmp(previous.data, response.data));
}

static void ordered_operations(void)
{
    assert(app_init(&app));
    assert(app.operation.trace.count == 0 && !app.operation.trace.truncated);
    before_matches_final(); parity();
    success("action=add&playlist=main&title=Track+D&artist=Sample");
    assert(app.operation.trace.count == 4);
    const PlaylistEvent *e = event(0, PLAYLIST_ALLOCATE, 0, 6);
    assert(!strcmp(e->title, "Track D") && !strcmp(e->artist, "Sample"));
    pointer(1, 0, 6, POINTER_PREV, 0, 3);
    pointer(2, 0, 3, POINTER_NEXT, 0, 6);
    pointer(3, 0, 0, POINTER_TAIL, 3, 6);
    assert(strstr(response.data, "{\"kind\":\"allocate\",\"playlist\":\"main\",\"id\":6,\"title\":\"Track D\",\"artist\":\"Sample\",\"prev\":null,\"next\":null}"));
    assert(strstr(response.data, "{\"kind\":\"pointer\",\"playlist\":\"main\",\"id\":null,\"field\":\"tail\",\"from\":3,\"to\":6}"));
    success("action=select&playlist=main&id=2");
    assert(app.operation.trace.count == 3);
    event(0, PLAYLIST_VISIT, 0, 1); event(1, PLAYLIST_VISIT, 0, 2);
    pointer(2, 0, 0, POINTER_CURRENT, 1, 2);
    success("action=delete&playlist=main&id=2");
    assert(app.operation.trace.count == 6);
    event(0, PLAYLIST_VISIT, 0, 1); event(1, PLAYLIST_VISIT, 0, 2);
    pointer(2, 0, 0, POINTER_CURRENT, 2, 3);
    pointer(3, 0, 1, POINTER_NEXT, 2, 3);
    pointer(4, 0, 3, POINTER_PREV, 2, 1);
    event(5, PLAYLIST_FREE, 0, 2);
    assert(app.operation.trace.before[0].nodes[1].id == 2);
    assert(!strcmp(app.operation.trace.before[0].nodes[1].title, "Slow Orbit"));
    api_state(&app, &previous);
    /* Survives unrelated allocation/reuse after the deleted node is gone. */
    Playlist scratch = {0};
    assert(playlist_add(&scratch, 99, "overwrite", "allocator reuse"));
    playlist_clear(&scratch);
    api_state(&app, &response);
    assert(!strcmp(previous.data, response.data));
    success("action=next&playlist=main");
    assert(app.operation.trace.count == 1);
    pointer(0, 0, 0, POINTER_CURRENT, 3, 6);
    success("action=next&playlist=main"); assert(app.operation.trace.count == 0);
    success("action=previous&playlist=main");
    pointer(0, 0, 0, POINTER_CURRENT, 6, 3);
    success("action=reverse&playlist=main");
    assert(app.operation.trace.count == 8);
    pointer(0, 0, 1, POINTER_NEXT, 3, 0);
    pointer(1, 0, 1, POINTER_PREV, 0, 3);
    pointer(2, 0, 3, POINTER_NEXT, 6, 1);
    pointer(3, 0, 3, POINTER_PREV, 1, 6);
    pointer(4, 0, 6, POINTER_NEXT, 0, 3);
    pointer(5, 0, 6, POINTER_PREV, 3, 0);
    pointer(6, 0, 0, POINTER_HEAD, 1, 6);
    pointer(7, 0, 0, POINTER_TAIL, 6, 1);
    success("action=merge&playlist=main&source=secondary");
    assert(app.operation.trace.count == 6);
    pointer(0, 0, 1, POINTER_NEXT, 0, 4);
    pointer(1, 1, 4, POINTER_PREV, 0, 1);
    pointer(2, 0, 0, POINTER_TAIL, 1, 5);
    pointer(3, 1, 0, POINTER_HEAD, 4, 0);
    pointer(4, 1, 0, POINTER_TAIL, 5, 0);
    pointer(5, 1, 0, POINTER_CURRENT, 4, 0);
    success("action=merge&playlist=main&source=secondary"); assert(app.operation.trace.count == 0);
    success("action=merge&playlist=secondary&source=main");
    assert(app.operation.trace.count == 6);
    pointer(0, 1, 0, POINTER_HEAD, 0, 6);
    pointer(1, 1, 0, POINTER_CURRENT, 0, 3);
    pointer(2, 1, 0, POINTER_TAIL, 0, 5);
    pointer(3, 0, 0, POINTER_HEAD, 6, 0);
    pointer(4, 0, 0, POINTER_TAIL, 5, 0);
    pointer(5, 0, 0, POINTER_CURRENT, 3, 0);
    success("action=add&playlist=main&title=Empty&artist=Sample");
    assert(app.operation.trace.count == 5);
    event(0, PLAYLIST_ALLOCATE, 0, 7);
    pointer(1, 0, 7, POINTER_PREV, 0, 0);
    pointer(2, 0, 0, POINTER_HEAD, 0, 7);
    pointer(3, 0, 0, POINTER_TAIL, 0, 7);
    pointer(4, 0, 0, POINTER_CURRENT, 0, 7);
    success("action=delete&playlist=main&id=7");
    assert(app.operation.trace.count == 5);
    event(0, PLAYLIST_VISIT, 0, 7);
    pointer(1, 0, 0, POINTER_CURRENT, 7, 0);
    pointer(2, 0, 0, POINTER_HEAD, 7, 0);
    pointer(3, 0, 0, POINTER_TAIL, 7, 0);
    event(4, PLAYLIST_FREE, 0, 7);
    success("action=next&playlist=main"); assert(app.operation.trace.count == 0);
    success("action=reverse&playlist=main"); assert(app.operation.trace.count == 2);
    pointer(0, 0, 0, POINTER_HEAD, 0, 0); pointer(1, 0, 0, POINTER_TAIL, 0, 0);
    success("action=select&playlist=secondary&id=3");
    rejected("action=select&playlist=secondary&id=999", 404);
    rejected("action=delete&playlist=secondary&id=999", 404);
    rejected("action=add&playlist=main&title=%FF&artist=Sample", 400);
    rejected("action=reverse&playlist=main&extra=x", 400);
    rejected("action=reset&extra=x", 400);
    rejected("action=merge&playlist=main&source=main", 400);
    rejected("action=next&playlist=main&playlist=main", 400);
    rejected("action=unknown&playlist=main", 400);
    fail_after = 0;
    rejected("action=add&playlist=main&title=Fail&artist=Sample", 500);
    fail_after = -1;
    /* Each reset allocation may fail; old nodes, IDs and trace must stay intact. */
    for (int i = 0; i < 5; i++) {
        fail_after = i; rejected("action=reset", 500); fail_after = -1;
    }
    uint64_t next_id = app.next_id;
    app.next_id = (uint64_t)UINT32_MAX + 1;
    rejected("action=reset", 500);
    rejected("action=add&playlist=main&title=No+IDs&artist=Sample", 500);
    app.next_id = next_id;
    assert(action("action=reset") == 200);
    assert(app.operation.trace.count == 0 && !app.operation.trace.truncated);
    assert(app.lists[0].head->id == next_id);
    before_matches_final(); parity();
    app_clear(&app);
}

static void capacity(void)
{
    assert(app_init(&app));
    app_clear(&app);
    char text[SONG_TEXT_BYTES + 1];
    memset(text, '"', SONG_TEXT_BYTES); text[SONG_TEXT_BYTES] = '\0';
    /* Largest IDs and maximally escaped allowed metadata, 200 old + 200 new. */
    for (uint32_t i = 0; i < SONG_LIMIT; i++)
        assert(playlist_add(&app.lists[0], UINT32_MAX - i, text, text));
    success("action=reverse&playlist=main");
    assert(app.operation.trace.count == 2 * SONG_LIMIT + 2);
    assert(!app.operation.trace.truncated && response.length < RESPONSE_CAP);
    size_t reverse_bytes = response.length;
    success("action=select&playlist=main&id=4294967295");
    assert(app.operation.trace.count == SONG_LIMIT + 1);
    for (size_t i = 0; i < SONG_LIMIT; i++)
        event(i, PLAYLIST_VISIT, 0, UINT32_MAX - (SONG_LIMIT - 1) + (uint32_t)i);
    rejected("action=add&playlist=secondary&title=Full&artist=Sample", 400);
    success("action=delete&playlist=main&id=4294967295");
    assert(app.operation.trace.count == SONG_LIMIT + 4);
    /* Worst escaping on an allocation record, too. */
    char form[BODY_CAP + 1];
    snprintf(form, sizeof(form), "action=add&playlist=main&title=%s&artist=%s", text, text);
    app.next_id = UINT32_MAX;
    success(form);
    assert(app.lists[0].size == SONG_LIMIT && app.operation.trace.count == 4);
    memset(text, '\\', SONG_TEXT_BYTES);
    snprintf(form, sizeof(form), "action=add&playlist=secondary&title=%s&artist=%s", text, text);
    success("action=delete&playlist=main&id=4294967295");
    app.next_id = UINT32_MAX;
    success(form);
    success("action=merge&playlist=main&source=secondary");
    assert(app.lists[0].size == SONG_LIMIT);
    success("action=reverse&playlist=main");
    assert(app.operation.trace.count == 2 * SONG_LIMIT + 2);
    assert(!app.operation.trace.truncated && response.length < RESPONSE_CAP);
    printf("trace capacity: PASS (%zu bytes, 200 before + 200 after, 402 pointer events; cap %d)\n",
           reverse_bytes, RESPONSE_CAP);
    app_clear(&app);
}

int main(void)
{
    ordered_operations(); capacity();
    puts("trace: PASS (event order, exact visits, replay parity, copied snapshot lifetime, rejection/allocation preservation, reset, full occupancy)");
    return 0;
}
