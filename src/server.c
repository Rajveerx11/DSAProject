#define _POSIX_C_SOURCE 200809L
#include "api.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#define HEADER_CAP 8192
#define READ_TIMEOUT_MS 2000
#define STATIC_CAP (1024 * 1024)

static volatile sig_atomic_t stopping;

static void stop_server(int sig)
{
    (void)sig;
    stopping = 1;
}

static int64_t clock_ms(void)
{
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) < 0) return -1;
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static ssize_t receive(int fd, void *out, size_t cap, int64_t deadline)
{
    while (!stopping) {
        int64_t now = clock_ms();
        if (now < 0 || now >= deadline) return -1;
        struct pollfd ready = {.fd = fd, .events = POLLIN};
        int rc = poll(&ready, 1, (int)(deadline - now));
        if (rc < 0 && errno == EINTR) continue;
        if (rc <= 0) return -1;
        ssize_t n = recv(fd, out, cap, 0);
        if (n < 0 && errno == EINTR) continue;
        return n;
    }
    return -1;
}

static bool send_all(int fd, const void *data, size_t length)
{
    const char *p = data;
    while (length && !stopping) {
        ssize_t n = send(fd, p, length, 0);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return false;
        p += n;
        length -= (size_t)n;
    }
    return !length;
}

static const char *reason(int status)
{
    switch (status) {
    case 200: return "OK";
    case 400: return "Bad Request";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 408: return "Request Timeout";
    case 413: return "Content Too Large";
    case 415: return "Unsupported Media Type";
    default: return "Internal Server Error";
    }
}

static void respond(int fd, int status, const char *type, const void *data, size_t length,
                    const char *allow)
{
    char header[2048];
    int n = snprintf(header, sizeof(header),
        "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\n"
        "Connection: close\r\nCache-Control: no-store\r\n"
        "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; "
        "img-src 'self'; connect-src 'self'; media-src 'self' blob:; "
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'\r\n"
        "X-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\n"
        "Referrer-Policy: no-referrer\r\n"
        "%s%s%s\r\n", status, reason(status), type, length,
        allow ? "Allow: " : "", allow ? allow : "", allow ? "\r\n" : "");
    if (n > 0 && (size_t)n < sizeof(header) && send_all(fd, header, (size_t)n))
        (void)send_all(fd, data, length);
}

static void error_response(int fd, int status, const char *message)
{
    /* Every caller supplies a fixed ASCII literal, never reflected request input. */
    char body[512];
    int n = snprintf(body, sizeof(body), "{\"ok\":false,\"error\":\"%s\"}", message);
    if (n > 0 && (size_t)n < sizeof(body))
        respond(fd, status, "application/json; charset=utf-8", body, (size_t)n, NULL);
}

static void method_error(int fd, const char *path)
{
    const char body[] = "{\"ok\":false,\"error\":\"Wrong method for this endpoint.\"}";
    respond(fd, 405, "application/json; charset=utf-8", body, sizeof(body) - 1,
            !strcmp(path, "/api/action") ? "POST" : "GET");
}

typedef struct {
    char method[16], path[256];
    char body[BODY_CAP + 1];
} Request;

typedef struct { char *name, *value; } Header;

static bool token(unsigned char c)
{
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
        || (c >= '0' && c <= '9') || (c && strchr("!#$%&'*+-.^_`|~", c));
}

static const char *header_value(Header *headers, size_t count, const char *name)
{
    for (size_t i = 0; i < count; i++)
        if (!strcmp(headers[i].name, name)) return headers[i].value;
    return NULL;
}

static bool local_host(const char *host, unsigned port)
{
    if (!host) return false;
    char address[64], localhost[64];
    (void)snprintf(address, sizeof(address), "127.0.0.1:%u", port);
    (void)snprintf(localhost, sizeof(localhost), "localhost:%u", port);
    return !strcasecmp(host, address) || !strcasecmp(host, localhost)
        || (port == 80 && (!strcasecmp(host, "localhost") || !strcmp(host, "127.0.0.1")));
}

static bool local_origin(const char *origin, const char *host)
{
    /* Same origin includes the hostname: localhost and 127.0.0.1 are not interchangeable. */
    if (!origin) return true; /* Non-browser clients have no ambient browser credentials. */
    return !strncmp(origin, "http://", 7) && !strcasecmp(origin + 7, host);
}

static bool content_length(const char *text, size_t *length)
{
    if (!text || !*text) return false;
    size_t n = 0;
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        if (*p < '0' || *p > '9' || n > BODY_CAP) return false;
        n = n * 10 + (size_t)(*p - '0');
    }
    *length = n;
    return true;
}

static bool form_type(const char *type)
{
    if (!type) return false;
    const char *base = "application/x-www-form-urlencoded";
    size_t len = strlen(base);
    if (strncasecmp(type, base, len)) return false;
    const char *rest = type + len;
    if (!*rest) return true;
    if (*rest++ != ';') return false;
    while (*rest == ' ' || *rest == '\t') rest++;
    return !strcasecmp(rest, "charset=UTF-8");
}

static int read_request(int fd, unsigned port, Request *request)
{
    char input[HEADER_CAP + 1];
    size_t used = 0;
    char *end = NULL;
    int64_t start = clock_ms();
    if (start < 0) return 500;
    int64_t deadline = start + READ_TIMEOUT_MS;
    while (!end) {
        if (used == HEADER_CAP) return 413;
        ssize_t n = receive(fd, input + used, HEADER_CAP - used, deadline);
        if (n < 0) return 408;
        if (!n) return 400;
        /* No NUL anywhere in the wire request, including already received body bytes. */
        if (memchr(input + used, '\0', (size_t)n)) return 400;
        used += (size_t)n;
        input[used] = '\0';
        end = strstr(input, "\r\n\r\n");
    }
    size_t header_bytes = (size_t)(end - input) + 4;
    size_t buffered_body = used - header_bytes;
    *end = '\0';
    for (char *p = input; p < end; p++) {
        unsigned char c = (unsigned char)*p;
        if (c == '\r') { if (p + 1 >= end || p[1] != '\n') return 400; }
        else if (c == '\n') { if (p == input || p[-1] != '\r') return 400; }
        else if ((c < 0x20 && c != '\t') || c > 0x7e) return 400;
    }
    char *line = strstr(input, "\r\n");
    /* A request without headers cannot have the mandatory Host. */
    if (!line) return 400;
    *line = '\0';
    char *space = strchr(input, ' ');
    if (!space) return 400;
    *space++ = '\0';
    char *version = strchr(space, ' ');
    if (!version) return 400;
    *version++ = '\0';
    if (strcmp(version, "HTTP/1.1") || !*input || strlen(input) >= sizeof(request->method)
        || !*space || *space != '/' || strlen(space) >= sizeof(request->path)) return 400;
    for (const unsigned char *p = (const unsigned char *)input; *p; p++)
        if (!token(*p)) return 400;
    for (const unsigned char *p = (const unsigned char *)space; *p; p++)
        if (*p <= 0x20 || *p >= 0x7f) return 400;
    strcpy(request->method, input); strcpy(request->path, space);
    Header headers[64];
    size_t count = 0;
    char *cursor = line + 2;
    while (*cursor) {
        char *next = strstr(cursor, "\r\n");
        if (next) *next = '\0';
        if (count == 64) return 413;
        char *colon = strchr(cursor, ':');
        if (!colon || colon == cursor) return 400;
        *colon++ = '\0';
        for (unsigned char *p = (unsigned char *)cursor; *p; p++) {
            if (!token(*p)) return 400;
            if (*p >= 'A' && *p <= 'Z') *p = (unsigned char)(*p + ('a' - 'A'));
        }
        while (*colon == ' ' || *colon == '\t') colon++;
        char *tail = colon + strlen(colon);
        while (tail > colon && (tail[-1] == ' ' || tail[-1] == '\t')) *--tail = '\0';
        for (size_t i = 0; i < count; i++)
            if (!strcmp(headers[i].name, cursor)) return 400;
        headers[count++] = (Header){cursor, colon};
        if (!next) break;
        cursor = next + 2;
    }
    const char *host = header_value(headers, count, "host");
    if (!local_host(host, port)) return 403;
    if (header_value(headers, count, "transfer-encoding") || header_value(headers, count, "expect")) return 400;
    bool post = !strcmp(request->method, "POST");
    bool get = !strcmp(request->method, "GET");
    if (!post && !get) return 405;
    if (post && !local_origin(header_value(headers, count, "origin"), host)) return 403;
    const char *site = header_value(headers, count, "sec-fetch-site");
    if (post && site && strcmp(site, "same-origin") && strcmp(site, "none")) return 403;
    const char *length_header = header_value(headers, count, "content-length");
    size_t length = 0;
    if ((post && !length_header) || (length_header && !content_length(length_header, &length))) return 400;
    if (length > BODY_CAP) return 413;
    if (get && length) return 400;
    if (post && !form_type(header_value(headers, count, "content-type"))) return 415;
    if (buffered_body > length) return 400;
    memcpy(request->body, input + header_bytes, buffered_body);
    while (buffered_body < length) {
        ssize_t n = receive(fd, request->body + buffered_body, length - buffered_body, deadline);
        if (n < 0) return 408;
        if (!n) return 400;
        if (memchr(request->body + buffered_body, '\0', (size_t)n)) return 400;
        buffered_body += (size_t)n;
    }
    request->body[length] = '\0';
    return 200;
}

static void serve_static(int fd, const char *path)
{
    const char *file = NULL, *type = NULL;
    if (!strcmp(path, "/") || !strcmp(path, "/index.html")) {
        file = "web/index.html"; type = "text/html; charset=utf-8";
    } else if (!strcmp(path, "/styles.css")) {
        file = "web/styles.css"; type = "text/css; charset=utf-8";
    } else if (!strcmp(path, "/app.js")) {
        file = "web/app.js"; type = "text/javascript; charset=utf-8";
    } else {
        error_response(fd, 404, "Static path not allowed."); return;
    }
    int asset = open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (asset < 0) { error_response(fd, 404, "Static file not available."); return; }
    struct stat statbuf;
    if (fstat(asset, &statbuf) < 0 || !S_ISREG(statbuf.st_mode)
        || statbuf.st_size < 0 || statbuf.st_size > STATIC_CAP) {
        close(asset); error_response(fd, 404, "Static file not available."); return;
    }
    size_t size = (size_t)statbuf.st_size;
    char *data = malloc(size ? size : 1);
    if (!data) { close(asset); error_response(fd, 500, "Allocation failed."); return; }
    size_t used = 0;
    while (used < size) {
        ssize_t n = read(asset, data + used, size - used);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) break;
        used += (size_t)n;
    }
    close(asset);
    if (used == size) respond(fd, 200, type, data, size, NULL);
    else error_response(fd, 500, "Static file changed or could not be read.");
    free(data);
}

static void handle(int fd, unsigned port, App *app)
{
    Request request;
    int status = read_request(fd, port, &request);
    if (status != 200) {
        if (status == 405) method_error(fd, request.path);
        else error_response(fd, status, status == 408 ? "Request read deadline exceeded." : "Request rejected by HTTP validation.");
        return;
    }
    bool state = !strcmp(request.path, "/api/state");
    bool action = !strcmp(request.path, "/api/action");
    if ((state && strcmp(request.method, "GET")) || (action && strcmp(request.method, "POST"))) {
        method_error(fd, request.path); return;
    }
    if (state || action) {
        Response *out = calloc(1, sizeof(*out));
        if (!out) { error_response(fd, 500, "Allocation failed."); return; }
        if (state) api_state(app, out);
        else status = api_action(app, request.body, out);
        if (out->failed) error_response(fd, 500, "Response capacity exceeded.");
        else respond(fd, status, "application/json; charset=utf-8", out->data, out->length, NULL);
        free(out);
    } else if (!strncmp(request.path, "/api/", 5)) {
        error_response(fd, 404, "Unknown API endpoint.");
    } else if (strcmp(request.method, "GET")) {
        method_error(fd, request.path);
    } else {
        serve_static(fd, request.path);
    }
}

int main(int argc, char **argv)
{
    unsigned port = 8080;
    if (argc != 1) {
        if (argc != 3 || strcmp(argv[1], "--port") || !*argv[2]) {
            fprintf(stderr, "Usage: %s [--port 1..65535]\n", argv[0]); return 1;
        }
        unsigned value = 0;
        for (const unsigned char *p = (const unsigned char *)argv[2]; *p; p++) {
            if (*p < '0' || *p > '9' || value > 65535) {
                fprintf(stderr, "Invalid port\n"); return 1;
            }
            value = value * 10 + (unsigned)(*p - '0');
        }
        if (!value || value > 65535) { fprintf(stderr, "Invalid port\n"); return 1; }
        port = value;
    }
    struct sigaction signals = {0};
    signals.sa_handler = stop_server;
    sigemptyset(&signals.sa_mask);
    if (sigaction(SIGINT, &signals, NULL) < 0 || sigaction(SIGTERM, &signals, NULL) < 0
        || signal(SIGPIPE, SIG_IGN) == SIG_ERR) {
        perror("signal"); return 1;
    }
    App app;
    if (!app_init(&app)) { fprintf(stderr, "Cannot allocate demo state\n"); return 1; }
    int listener = socket(AF_INET, SOCK_STREAM, 0);
    if (listener < 0) { perror("socket"); app_clear(&app); return 1; }
    if (fcntl(listener, F_SETFL, O_NONBLOCK) < 0) {
        perror("nonblocking listener"); close(listener); app_clear(&app); return 1;
    }
    int reuse = 1;
    (void)setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    struct sockaddr_in address = {.sin_family = AF_INET, .sin_port = htons((uint16_t)port),
                                 .sin_addr = {.s_addr = htonl(INADDR_LOOPBACK)}};
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) < 0 || listen(listener, 16) < 0) {
        perror("listen/bind"); close(listener); app_clear(&app); return 1;
    }
    printf("Music lab listening on http://127.0.0.1:%u\n", port);
    fflush(stdout);
    /* ponytail: serial classroom server; use an event loop if concurrent users become a requirement. */
    int result = 0;
    while (!stopping) {
        /* Nonblocking accept plus poll stays interruptible even if a ready client disappears. */
        struct pollfd ready = {.fd = listener, .events = POLLIN};
        int rc = poll(&ready, 1, 200);
        if (rc < 0 && errno == EINTR) continue;
        if (rc < 0) { perror("poll"); result = 1; break; }
        if (!rc || stopping) continue;
        int fd = accept(listener, NULL, NULL);
        if (fd < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK
                       || errno == ECONNABORTED)) continue;
        if (fd < 0) { perror("accept"); result = 1; break; }
        struct timeval timeout = {.tv_sec = 2};
        if (setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) == 0)
            handle(fd, port, &app);
        close(fd);
    }
    close(listener);
    app_clear(&app);
    return result;
}
