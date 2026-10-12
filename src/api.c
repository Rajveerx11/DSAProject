#include "api.h"

#include <inttypes.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void writef(Response *out, const char *format, ...)
{
    if (out->failed) return;
    va_list args;
    va_start(args, format);
    int n = vsnprintf(out->data + out->length, RESPONSE_CAP - out->length,
                      format, args);
    va_end(args);
    if (n < 0 || (size_t)n >= RESPONSE_CAP - out->length) out->failed = true;
    else out->length += (size_t)n;
}

static void json_string(Response *out, const char *text)
{
    writef(out, "\"");
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        if (*p == '"' || *p == '\\') writef(out, "\\%c", *p);
        else if (*p < 0x20) writef(out, "\\u%04x", (unsigned)*p);
        else writef(out, "%c", *p);
    }
    writef(out, "\"");
}

static void json_pointer(Response *out, const SongNode *node)
{
    if (node) writef(out, "%" PRIu32, node->id);
    else writef(out, "null");
}

void api_error(Response *out, const char *message)
{
    out->length = 0;
    out->failed = false;
    writef(out, "{\"ok\":false,\"error\":");
    json_string(out, message);
    writef(out, "}");
}

void api_state(const App *app, Response *out)
{
    out->length = 0;
    out->failed = false;
    writef(out, "{\"ok\":true,\"playlists\":[");
    for (size_t i = 0; i < 2; i++) {
        const Playlist *list = &app->lists[i];
        writef(out, "%s{\"id\":\"%s\",\"name\":\"%s\",\"head\":",
               i ? "," : "", i ? "secondary" : "main",
               i ? "Side B" : "My playlist");
        json_pointer(out, list->head);
        writef(out, ",\"tail\":"); json_pointer(out, list->tail);
        writef(out, ",\"current\":"); json_pointer(out, list->current);
        writef(out, ",\"size\":%zu,\"nodes\":[", list->size);
        bool first = true;
        for (SongNode *node = list->head; node; node = node->next) {
            writef(out, "%s{\"id\":%" PRIu32 ",\"title\":", first ? "" : ",", node->id);
            json_string(out, node->title);
            writef(out, ",\"artist\":"); json_string(out, node->artist);
            writef(out, ",\"prev\":"); json_pointer(out, node->prev);
            writef(out, ",\"next\":"); json_pointer(out, node->next);
            writef(out, "}");
            first = false;
        }
        writef(out, "]}");
    }
    const Operation *op = &app->operation;
    writef(out, "],\"operation\":{\"action\":"); json_string(out, op->action);
    writef(out, ",\"message\":"); json_string(out, op->message);
    writef(out, ",\"complexity\":"); json_string(out, op->complexity);
    writef(out, ",\"steps\":[");
    for (size_t i = 0; i < 5 && op->steps[i]; i++) {
        writef(out, "%s", i ? "," : ""); json_string(out, op->steps[i]);
    }
    writef(out, "],\"changed\":[");
    for (size_t i = 0; i < op->count; i++)
        writef(out, "%s%" PRIu32, i ? "," : "", op->changed[i]);
    writef(out, "]}}");
}

static void changed(Operation *op, const SongNode *node)
{
    if (!node) return;
    for (size_t i = 0; i < op->count; i++)
        if (op->changed[i] == node->id) return;
    if (op->count < SONG_LIMIT + 1) op->changed[op->count++] = node->id;
}

static bool reset(App *app)
{
    static const char *titles[] = {"Paper Moon", "Slow Orbit", "Copper Dawn",
                                   "Quiet Tide", "Night Window"};
    if (app->next_id > UINT32_MAX - 4ULL) return false;
    Playlist fresh[2] = {{0}, {0}};
    for (size_t i = 0; i < 5; i++) {
        if (!playlist_add(&fresh[i < 3 ? 0 : 1], (uint32_t)(app->next_id + i),
                          titles[i], "Demo tones")) {
            playlist_clear(&fresh[0]); playlist_clear(&fresh[1]);
            return false;
        }
    }
    app_clear(app);
    app->lists[0] = fresh[0]; app->lists[1] = fresh[1];
    app->next_id += 5;
    app->operation = (Operation){.action = "reset", .message = "Restored generated-tone demo playlists with fresh IDs.",
        .complexity = "O(n)", .steps = {"Free old nodes", "Append fresh demo nodes", "current = head in each list"}};
    for (size_t i = 0; i < 2; i++)
        for (SongNode *n = app->lists[i].head; n; n = n->next) changed(&app->operation, n);
    return true;
}

bool app_init(App *app)
{
    *app = (App){.next_id = 1};
    return reset(app);
}

void app_clear(App *app)
{
    playlist_clear(&app->lists[0]); playlist_clear(&app->lists[1]);
}

typedef struct { char *key, *value; } Field;

static int hex(unsigned char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static bool decode(char *text)
{
    char *out = text;
    for (char *p = text; *p; p++) {
        unsigned char c = (unsigned char)*p;
        if (c == '%') {
            if (!p[1] || !p[2] || hex((unsigned char)p[1]) < 0 || hex((unsigned char)p[2]) < 0) return false;
            c = (unsigned char)(hex((unsigned char)p[1]) * 16 + hex((unsigned char)p[2]));
            p += 2;
        } else if (c == '+') c = ' ';
        if (c < 0x20 || c == 0x7f) return false;
        *out++ = (char)c;
    }
    *out = '\0';
    return true;
}

static int fields(char *body, Field out[5])
{
    int count = 0;
    char *part = body;
    if (!part || !*part) return -1;
    while (part) {
        char *next = strchr(part, '&');
        if (next) *next++ = '\0';
        char *equal = strchr(part, '=');
        if (!equal || count == 5) return -1;
        *equal++ = '\0';
        if (!decode(part) || !decode(equal) || !*part) return -1;
        for (int i = 0; i < count; i++) if (!strcmp(out[i].key, part)) return -1;
        out[count++] = (Field){part, equal};
        part = next;
    }
    return count;
}

static const char *value(Field *fields, int count, const char *key)
{
    for (int i = 0; i < count; i++)
        if (!strcmp(fields[i].key, key)) return fields[i].value;
    return NULL;
}

static int list_index(const char *name)
{
    if (name && !strcmp(name, "main")) return 0;
    if (name && !strcmp(name, "secondary")) return 1;
    return -1;
}

static bool parse_id(const char *text, uint32_t *id)
{
    if (!text || !*text) return false;
    uint64_t number = 0;
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        if (*p < '0' || *p > '9') return false;
        number = number * 10 + (*p - '0');
        if (number > UINT32_MAX) return false;
    }
    if (!number) return false;
    *id = (uint32_t)number;
    return true;
}

static int fail(Response *out, int status, const char *message)
{
    api_error(out, message);
    return status;
}

int api_action(App *app, char *body, Response *out)
{
    Field form[5];
    int count = fields(body, form);
    if (count < 0) return fail(out, 400, "Malformed form, duplicate fields, or invalid encoding.");
    const char *action = value(form, count, "action");
    if (!action) return fail(out, 400, "Missing action.");
    if (!strcmp(action, "reset")) {
        if (count != 1) return fail(out, 400, "Reset accepts only action.");
        if (!reset(app)) return fail(out, 500, "Cannot allocate demo nodes or IDs.");
        api_state(app, out);
        return 200;
    }
    int index = list_index(value(form, count, "playlist"));
    if (index < 0) return fail(out, 400, "Unknown or missing playlist.");
    Playlist *list = &app->lists[index];
    Operation op = {0};
    if (!strcmp(action, "add")) {
        const char *title = value(form, count, "title"), *artist = value(form, count, "artist");
        char clean_title[SONG_TEXT_BYTES + 1], clean_artist[SONG_TEXT_BYTES + 1];
        if (count != 4 || !title || !artist || !song_text(clean_title, title) || !song_text(clean_artist, artist))
            return fail(out, 400, "Title and artist must be nonempty UTF-8, at most 127 bytes, without controls.");
        if (app->lists[0].size + app->lists[1].size >= SONG_LIMIT)
            return fail(out, 400, "Maximum 200 songs across both playlists.");
        if (app->next_id > UINT32_MAX) return fail(out, 500, "Song IDs exhausted.");
        op = (Operation){.action = "add", .message = "Appended a node to the tail.", .complexity = "O(1)"};
        changed(&op, list->tail);
        bool empty = !list->head;
        SongNode *node = playlist_add(list, (uint32_t)app->next_id, clean_title, clean_artist);
        if (!node) return fail(out, 500, "Cannot allocate song node.");
        app->next_id++;
        changed(&op, node);
        if (empty) {
            op.steps[0] = "newNode.prev = newNode.next = NULL";
            op.steps[1] = "head = tail = current = newNode";
        } else {
            op.steps[0] = "newNode.prev = oldTail";
            op.steps[1] = "oldTail.next = newNode";
            op.steps[2] = "tail = newNode";
        }
    } else if (!strcmp(action, "delete") || !strcmp(action, "select")) {
        uint32_t id;
        if (count != 3 || !parse_id(value(form, count, "id"), &id))
            return fail(out, 400, "Expected a positive integer song ID and no extra fields.");
        SongNode *node = playlist_find(list, id);
        if (!node) return fail(out, 404, "Song ID not in this playlist.");
        if (!strcmp(action, "select")) {
            op = (Operation){.action = "select", .message = "Selected the existing node.", .complexity = "O(n)",
                .steps = {"Search by ID", "current = foundNode"}};
            changed(&op, list->current); changed(&op, node);
            (void)playlist_select(list, id);
        } else {
            op = (Operation){.action = "delete", .message = "Unlinked and freed the song node.", .complexity = "O(n)"};
            changed(&op, node); changed(&op, node->prev); changed(&op, node->next);
            op.steps[0] = "Search by ID";
            op.steps[1] = node->prev ? "node.prev.next = node.next" : "head = node.next";
            op.steps[2] = node->next ? "node.next.prev = node.prev" : "tail = node.prev";
            op.steps[3] = list->current == node ? "current = next, else previous, else NULL" : "Keep current song";
            op.steps[4] = "Free node";
            (void)playlist_delete(list, id);
        }
    } else if (!strcmp(action, "next") || !strcmp(action, "previous")) {
        if (count != 2) return fail(out, 400, "Navigation accepts only action and playlist.");
        bool forward = !strcmp(action, "next");
        op = (Operation){.action = forward ? "next" : "previous", .complexity = "O(1)"};
        SongNode *old = list->current;
        if (playlist_move(list, forward)) {
            op.message = "Moved current to the adjacent song.";
            op.steps[0] = forward ? "current = current.next" : "current = current.prev";
            changed(&op, old); changed(&op, list->current);
        } else {
            op.message = old ? "At the playlist boundary; current unchanged." : "Playlist is empty; current remains NULL.";
            op.steps[0] = "No pointer changes";
        }
    } else if (!strcmp(action, "reverse")) {
        if (count != 2) return fail(out, 400, "Reverse accepts only action and playlist.");
        op = (Operation){.action = "reverse", .message = "Reversed links; kept the same current song.", .complexity = "O(n)",
            .steps = {"Swap each node.prev and node.next", "Swap head and tail", "Keep current song"}};
        /* Traversal visits unique nodes; no duplicate scan is needed here. */
        for (SongNode *node = list->head; node; node = node->next)
            op.changed[op.count++] = node->id;
        playlist_reverse(list);
    } else if (!strcmp(action, "merge")) {
        int source = list_index(value(form, count, "source"));
        if (count != 3 || source < 0 || source == index)
            return fail(out, 400, "Merge requires a distinct valid source playlist.");
        Playlist *other = &app->lists[source];
        op = (Operation){.action = "merge", .complexity = "O(1)"};
        if (!other->head) {
            op.message = "Source is empty; no pointer changes.";
            op.steps[0] = "No pointer changes";
        } else {
            changed(&op, list->tail); changed(&op, other->head); changed(&op, other->tail);
            changed(&op, other->current);
            if (list->head) {
                op.steps[0] = "destination.tail.next = source.head";
                op.steps[1] = "source.head.prev = destination.tail";
                op.steps[2] = "destination.tail = source.tail; keep current";
            } else {
                op.steps[0] = "destination.head = source.head";
                op.steps[1] = "destination.tail = source.tail";
                op.steps[2] = "destination.current = source.current";
            }
            op.steps[3] = "Add source size; empty source endpoints and current";
            op.message = "Transferred source nodes without copying songs.";
        }
        (void)playlist_merge(list, other);
    } else {
        return fail(out, 400, "Unsupported action.");
    }
    app->operation = op;
    api_state(app, out);
    return 200;
}
