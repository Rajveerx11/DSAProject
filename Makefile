CC ?= cc
CFLAGS ?= -O2 -g
WARNINGS = -std=c11 -Wall -Wextra -Wpedantic -Werror
CPPFLAGS += -Isrc
SOURCES = src/server.c src/api.c src/playlist.c
HEADERS = src/api.h src/playlist.h
SANITIZERS = -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer -fno-pie -no-pie

.PHONY: all test test-api sanitize clean
all: build/musiclab

build:
	mkdir -p build

build/musiclab: $(SOURCES) $(HEADERS) | build
	$(CC) $(CPPFLAGS) $(CFLAGS) $(WARNINGS) $(SOURCES) -o $@

build/native: tests/native.c src/playlist.c src/playlist.h | build
	$(CC) $(CPPFLAGS) $(CFLAGS) $(WARNINGS) tests/native.c src/playlist.c -o $@

build/native-sanitize: tests/native.c src/playlist.c src/playlist.h | build
	$(CC) $(CPPFLAGS) $(WARNINGS) $(SANITIZERS) tests/native.c src/playlist.c -o $@

build/musiclab-sanitize: $(SOURCES) $(HEADERS) | build
	$(CC) $(CPPFLAGS) $(WARNINGS) $(SANITIZERS) $(SOURCES) -o $@

test: build/native build/musiclab
	./build/native
	node tests/api.mjs ./build/musiclab

test-api: build/musiclab
	node tests/api.mjs ./build/musiclab

sanitize: build/native-sanitize build/musiclab-sanitize
	ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 UBSAN_OPTIONS=halt_on_error=1 ./build/native-sanitize
	ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 UBSAN_OPTIONS=halt_on_error=1 node tests/api.mjs ./build/musiclab-sanitize

clean:
	rm -rf build
