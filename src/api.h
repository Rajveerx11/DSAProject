#ifndef API_H
#define API_H

#include "playlist.h"

#define RESPONSE_CAP (512 * 1024)
#define BODY_CAP 4096
#define TRACE_EVENT_LIMIT (3 * SONG_LIMIT + 32)

typedef struct {
    uint32_t id, prev, next;
    char title[SONG_TEXT_BYTES + 1], artist[SONG_TEXT_BYTES + 1];
} SongSnapshot;

typedef struct {
    uint32_t head, tail, current;
    size_t size;
    SongSnapshot nodes[SONG_LIMIT];
} PlaylistSnapshot;

typedef struct {
    PlaylistSnapshot before[2];
    struct { PlaylistEvent event; unsigned playlist; } events[TRACE_EVENT_LIMIT];
    size_t count;
    bool truncated;
} OperationTrace;

typedef struct {
    const char *action, *message, *complexity;
    const char *steps[5];
    uint32_t changed[SONG_LIMIT + 1];
    size_t count;
    OperationTrace trace;
} Operation;

typedef struct {
    Playlist lists[2];
    uint64_t next_id;
    Operation operation;
} App;

typedef struct {
    char data[RESPONSE_CAP];
    size_t length;
    bool failed;
} Response;

bool app_init(App *app);
void app_clear(App *app);
void api_state(const App *app, Response *response);
int api_action(App *app, char *body, Response *response);
void api_error(Response *response, const char *message);

#endif
