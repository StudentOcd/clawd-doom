// clawd-doom: the doomgeneric platform layer for Claude Code.
//
// The engine has no window. Each frame becomes a grid of half-block cells,
// the top pixel the cell's foreground and the bottom pixel its background,
// written to stdout as one line: "F" then the cells in the base64 form a
// Claude Code `Raster` takes. The plugin hands the line straight to the
// terminal.
//
// Input comes from a small control file the plugin rewrites while you play
// (path in CLAWD_DOOM_CONTROL):
//
//   <seq> <columns> <rows>
//   <doom key code> <doom key code> ...      (the keys held right now)
//
// The engine reads it every frame: a key that appears is pressed, one that
// goes away is released, and a new size resizes the picture. `seq` is a
// heartbeat: if it stops changing for HEARTBEAT_MS the plugin is gone and
// the engine quits rather than run on unseen.
//
// Licensed GPL-2.0, as doomgeneric is.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "doomgeneric.h"
#include "doomkeys.h"

#ifdef _WIN32
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#else
#include <time.h>
#include <unistd.h>
#endif

#define MAX_COLUMNS 512
#define MAX_ROWS 256
#define MAX_HELD 32
#define FRAME_EVERY_MS 50
#define HEARTBEAT_MS 6000

static const char *control_path;
static int columns = 120;
static int rows = 45;

static int held[MAX_HELD];
static int held_count;

// Key events waiting for DG_GetKey: pressed flag and doom key code.
static struct { int pressed; unsigned char key; } queue[64];
static int queue_head, queue_tail;

static long last_seq = -1;
static uint32_t last_seq_at;
static uint32_t last_frame_at;

static unsigned char *cells;
static char *line;

uint32_t DG_GetTicksMs(void)
{
#ifdef _WIN32
    return (uint32_t)GetTickCount64();
#else
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint32_t)(now.tv_sec * 1000 + now.tv_nsec / 1000000);
#endif
}

void DG_SleepMs(uint32_t ms)
{
#ifdef _WIN32
    Sleep(ms);
#else
    struct timespec wait = { ms / 1000, (long)(ms % 1000) * 1000000L };
    nanosleep(&wait, NULL);
#endif
}

static void push_key(int pressed, int key)
{
    int next = (queue_tail + 1) % 64;

    if (next != queue_head) {
        queue[queue_tail].pressed = pressed;
        queue[queue_tail].key = (unsigned char)key;
        queue_tail = next;
    }
}

static int is_held(const int *list, int count, int key)
{
    for (int i = 0; i < count; i++) {
        if (list[i] == key) {
            return 1;
        }
    }

    return 0;
}

// Reads the control file and turns what changed into key events.
static void read_control(void)
{
    if (!control_path) {
        return;
    }

    FILE *file = fopen(control_path, "rb");

    if (!file) {
        return;
    }

    char text[1024];
    size_t size = fread(text, 1, sizeof(text) - 1, file);
    fclose(file);
    text[size] = '\0';

    long seq;
    int new_columns, new_rows;
    int offset = 0;

    if (sscanf(text, "%ld %d %d%n", &seq, &new_columns, &new_rows, &offset) != 3) {
        return;
    }

    uint32_t now = DG_GetTicksMs();

    if (seq != last_seq) {
        last_seq = seq;
        last_seq_at = now;
    }

    if (new_columns >= 8 && new_columns <= MAX_COLUMNS && new_rows >= 4 && new_rows <= MAX_ROWS) {
        columns = new_columns;
        rows = new_rows;
    }

    int now_held[MAX_HELD];
    int now_count = 0;
    char *cursor = text + offset;

    while (now_count < MAX_HELD) {
        char *end;
        long key = strtol(cursor, &end, 10);

        if (end == cursor) {
            break;
        }

        if (key > 0 && key < 256) {
            now_held[now_count++] = (int)key;
        }

        cursor = end;
    }

    for (int i = 0; i < held_count; i++) {
        if (!is_held(now_held, now_count, held[i])) {
            push_key(0, held[i]);
        }
    }

    for (int i = 0; i < now_count; i++) {
        if (!is_held(held, held_count, now_held[i])) {
            push_key(1, now_held[i]);
        }
    }

    memcpy(held, now_held, sizeof(int) * (size_t)now_count);
    held_count = now_count;
}

static const char BASE64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static size_t base64(const unsigned char *in, size_t size, char *out)
{
    size_t o = 0;

    for (size_t i = 0; i < size; i += 3) {
        uint32_t chunk = (uint32_t)in[i] << 16;

        if (i + 1 < size) chunk |= (uint32_t)in[i + 1] << 8;
        if (i + 2 < size) chunk |= in[i + 2];

        out[o++] = BASE64[(chunk >> 18) & 63];
        out[o++] = BASE64[(chunk >> 12) & 63];
        out[o++] = i + 1 < size ? BASE64[(chunk >> 6) & 63] : '=';
        out[o++] = i + 2 < size ? BASE64[chunk & 63] : '=';
    }

    return o;
}

static void put_u32(unsigned char *at, uint32_t value)
{
    at[0] = (unsigned char)value;
    at[1] = (unsigned char)(value >> 8);
    at[2] = (unsigned char)(value >> 16);
    at[3] = (unsigned char)(value >> 24);
}

// The average colour of the screen pixels under one output pixel.
static uint32_t sample(int px, int py, int width, int height)
{
    int x0 = px * DOOMGENERIC_RESX / width, x1 = (px + 1) * DOOMGENERIC_RESX / width;
    int y0 = py * DOOMGENERIC_RESY / height, y1 = (py + 1) * DOOMGENERIC_RESY / height;

    if (x1 <= x0) x1 = x0 + 1;
    if (y1 <= y0) y1 = y0 + 1;

    uint32_t r = 0, g = 0, b = 0, n = 0;

    for (int y = y0; y < y1; y++) {
        for (int x = x0; x < x1; x++) {
            uint32_t pixel = DG_ScreenBuffer[y * DOOMGENERIC_RESX + x];
            r += (pixel >> 16) & 0xff;
            g += (pixel >> 8) & 0xff;
            b += pixel & 0xff;
            n++;
        }
    }

    return ((r / n) << 16) | ((g / n) << 8) | (b / n);
}

void DG_Init(void)
{
#ifdef _WIN32
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    control_path = getenv("CLAWD_DOOM_CONTROL");
    cells = malloc((size_t)MAX_COLUMNS * MAX_ROWS * 12);
    line = malloc((size_t)MAX_COLUMNS * MAX_ROWS * 16 + 8);
    last_seq_at = DG_GetTicksMs();
    read_control();
}

void DG_DrawFrame(void)
{
    read_control();

    // Read the clock after the control file: reading it can stamp last_seq_at,
    // and a clock read before that would make the difference wrap around.
    uint32_t now = DG_GetTicksMs();

    if (control_path && (int32_t)(now - last_seq_at) > HEARTBEAT_MS) {
        fprintf(stderr, "clawd-doom: the plugin stopped answering, quitting\n");
        exit(0);
    }

    if (now - last_frame_at < FRAME_EVERY_MS) {
        return;
    }

    last_frame_at = now;

    int height = rows * 2;
    unsigned char *at = cells;

    for (int cy = 0; cy < rows; cy++) {
        for (int cx = 0; cx < columns; cx++) {
            put_u32(at, 0x2580);
            put_u32(at + 4, sample(cx, cy * 2, columns, height));
            put_u32(at + 8, sample(cx, cy * 2 + 1, columns, height));
            at += 12;
        }
    }

    size_t size = 0;
    line[size++] = 'F';
    size += (size_t)sprintf(line + size, "%d,%d,", columns, rows);
    size += base64(cells, (size_t)(at - cells), line + size);
    line[size++] = '\n';
    fwrite(line, 1, size, stdout);
    fflush(stdout);
}

int DG_GetKey(int *pressed, unsigned char *key)
{
    if (queue_head == queue_tail) {
        return 0;
    }

    *pressed = queue[queue_head].pressed;
    *key = queue[queue_head].key;
    queue_head = (queue_head + 1) % 64;

    return 1;
}

void DG_SetWindowTitle(const char *title)
{
    (void)title;
}

int main(int argc, char **argv)
{
    doomgeneric_Create(argc, argv);

    for (;;) {
        doomgeneric_Tick();
    }

    return 0;
}
