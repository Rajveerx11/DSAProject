#ifndef API_H
#define API_H

#include "playlist.h"

#define RESPONSE_CAP 262144
#define BODY_CAP 4096

typedef struct {
    const char *action, *message, *complexity;
    const char *steps[5];
    uint32_t changed[SONG_LIMIT + 1];
    size_t count;
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
