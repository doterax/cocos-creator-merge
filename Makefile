CC      = clang++
CFLAGS  = -std=c++17 -Wall -Isrc

TARGET  = cocos-creator-merge
SRCS    = src/merge.cpp
HDRS    = src/merge.h src/json.hpp

RFLAGS  = $(CFLAGS) -O2 -DNDEBUG
DFLAGS  = $(CFLAGS) -g -O0

PREFIX ?= /usr/local

ifeq ($(OS),Windows_NT)
  EXT = .exe
else
  EXT =
endif

.PHONY: all release debug clean install

all: release

release: build/release/$(TARGET)$(EXT)

debug: build/debug/$(TARGET)$(EXT)

build/release/$(TARGET)$(EXT): $(SRCS) $(HDRS) | build/release
	$(CC) $(RFLAGS) -o $@ $(SRCS)

build/debug/$(TARGET)$(EXT): $(SRCS) $(HDRS) | build/debug
	$(CC) $(DFLAGS) -o $@ $(SRCS)

build/release build/debug:
	mkdir -p $@

install: release
	install -d $(DESTDIR)$(PREFIX)/bin
	install -m 755 build/release/$(TARGET)$(EXT) $(DESTDIR)$(PREFIX)/bin/

clean:
	rm -rf build/release build/debug
