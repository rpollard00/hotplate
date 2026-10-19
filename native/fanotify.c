#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifdef __linux__
#include <sys/fanotify.h>
#include <stddef.h>

#define MAX_ROOTS 1024
#define MAX_RULES 16
#define MAX_PATH_BYTES 4096
#define MAX_POLICY_BYTES (8 * 1024 * 1024)

struct scope_rule {
    char *value;
    int is_prefix;
};

struct scope_root {
    char *path;
    int is_directory;
    struct scope_rule rules[MAX_RULES];
    size_t rule_count;
};

static volatile sig_atomic_t stopping = 0;
static struct scope_root roots[MAX_ROOTS];
static size_t root_count = 0;
static uid_t target_uid;
static char boot_id[128];

static void stop_signal(int signal_number) {
    (void) signal_number;
    stopping = 1;
}

static void unavailable(const char *reason) {
    printf("{\"type\":\"unavailable\",\"reason\":\"%s\"}\n", reason);
    fflush(stdout);
}

static void loss(const char *reason) {
    printf("{\"type\":\"loss\",\"reason\":\"%s\"}\n", reason);
}

static int load_text(const char *path, char *buffer, size_t capacity) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    ssize_t count = read(fd, buffer, capacity - 1);
    int saved_errno = errno;
    close(fd);
    errno = saved_errno;
    if (count < 0 || (size_t) count >= capacity - 1) return -1;
    buffer[count] = '\0';
    return 0;
}

static int start_ticks(pid_t pid, unsigned long long *ticks) {
    char path[64];
    char text[8192];
    snprintf(path, sizeof(path), "/proc/%ld/stat", (long) pid);
    if (load_text(path, text, sizeof(text)) != 0) return -1;
    char *end = strrchr(text, ')');
    if (end == NULL || end[1] != ' ') return -1;
    char *cursor = end + 2;
    for (unsigned field = 3; field < 22; field++) {
        cursor = strchr(cursor, ' ');
        if (cursor == NULL) return -1;
        cursor++;
    }
    char *tail;
    errno = 0;
    *ticks = strtoull(cursor, &tail, 10);
    return errno == 0 && tail != cursor && (*tail == ' ' || *tail == '\0') ? 0 : -1;
}

static int process_uid(pid_t pid, uid_t *uid) {
    char path[64];
    char text[16384];
    snprintf(path, sizeof(path), "/proc/%ld/status", (long) pid);
    if (load_text(path, text, sizeof(text)) != 0) return -1;
    const char *line = strstr(text, "\nUid:");
    unsigned long real_uid;
    unsigned long effective_uid;
    if (line == NULL || sscanf(line + 1, "Uid:\t%lu\t%lu", &real_uid, &effective_uid) != 2 || effective_uid > UINT_MAX) return -1;
    *uid = (uid_t) effective_uid;
    return 0;
}

static int pidfd_alive(int pidfd) {
    if (pidfd < 0) return 0;
    struct pollfd descriptor = { .fd = pidfd, .events = POLLIN };
    return poll(&descriptor, 1, 0) == 0;
}

static int relative_components(const char *path) {
    if (*path == '\0' || *path == '/') return 0;
    const char *cursor = path;
    while (1) {
        const char *end = strchr(cursor, '/');
        size_t length = end == NULL ? strlen(cursor) : (size_t) (end - cursor);
        if (length == 0 || (length == 1 && cursor[0] == '.') || (length == 2 && cursor[0] == '.' && cursor[1] == '.')) return 0;
        if (end == NULL) return 1;
        cursor = end + 1;
    }
}

static int excluded(const struct scope_root *root, const char *relative) {
    for (size_t index = 0; index < root->rule_count; index++) {
        const struct scope_rule *rule = &root->rules[index];
        size_t length = strlen(rule->value);
        if (rule->is_prefix) {
            if (strncmp(relative, rule->value, length) == 0 && (relative[length] == '\0' || relative[length] == '/')) return 1;
        } else {
            const char *component = relative;
            while (*component != '\0') {
                const char *end = strchr(component, '/');
                size_t component_length = end == NULL ? strlen(component) : (size_t) (end - component);
                if (length == component_length && strncmp(component, rule->value, length) == 0) return 1;
                if (end == NULL) break;
                component = end + 1;
            }
        }
    }
    return 0;
}

static int under_root(const char *path) {
    if (path[0] != '/' || !relative_components(path + 1)) return 0;
    for (size_t index = 0; index < root_count; index++) {
        const struct scope_root *root = &roots[index];
        size_t length = strlen(root->path);
        if (strncmp(path, root->path, length) != 0) continue;
        if (path[length] == '\0') return 1;
        if (root->is_directory && path[length] == '/' && !excluded(root, path + length + 1)) return 1;
    }
    return 0;
}

static char *scope_token(char **cursor, const char *end) {
    if (*cursor >= end) return NULL;
    char *terminator = memchr(*cursor, '\0', (size_t) (end - *cursor));
    if (terminator == NULL || terminator == *cursor || (size_t) (terminator - *cursor) > MAX_PATH_BYTES) return NULL;
    char *value = *cursor;
    *cursor = terminator + 1;
    return value;
}

static int parse_scope(char *input, size_t size) {
    char *cursor = input;
    const char *end = input + size;
    char *token = scope_token(&cursor, end);
    if (token == NULL || strcmp(token, "scope-v1") != 0) return -1;
    while ((token = scope_token(&cursor, end)) != NULL) {
        if (strcmp(token, "end-scope") == 0) return root_count > 0 && cursor == end ? 0 : -1;
        if (strcmp(token, "root") != 0 || root_count >= MAX_ROOTS) return -1;
        struct scope_root *root = &roots[root_count++];
        char *extent = scope_token(&cursor, end);
        char *path = scope_token(&cursor, end);
        if (extent == NULL || path == NULL || (strcmp(extent, "directory") != 0 && strcmp(extent, "file") != 0)
            || path[0] != '/' || !relative_components(path + 1)) return -1;
        root->is_directory = strcmp(extent, "directory") == 0;
        char *canonical = realpath(path, NULL);
        struct stat metadata;
        if (canonical == NULL) return -1;
        int valid = strcmp(canonical, path) == 0 && lstat(canonical, &metadata) == 0
            && (root->is_directory ? S_ISDIR(metadata.st_mode) : S_ISREG(metadata.st_mode));
        if (!valid) { free(canonical); return -1; }
        root->path = canonical;
        while ((token = scope_token(&cursor, end)) != NULL && strcmp(token, "end-root") != 0) {
            if (root->rule_count >= MAX_RULES || (strcmp(token, "segment") != 0 && strcmp(token, "prefix") != 0)) return -1;
            int is_prefix = strcmp(token, "prefix") == 0;
            char *value = scope_token(&cursor, end);
            if (value == NULL || !relative_components(value) || (!is_prefix && strchr(value, '/') != NULL)) return -1;
            struct scope_rule *rule = &root->rules[root->rule_count++];
            rule->value = strdup(value);
            if (rule->value == NULL) return -1;
            rule->is_prefix = is_prefix;
        }
        if (token == NULL) return -1;
    }
    return -1;
}

static int read_scope(FILE *stream) {
    char *input = malloc(MAX_POLICY_BYTES + 1);
    if (input == NULL) return -1;
    size_t size = fread(input, 1, MAX_POLICY_BYTES + 1, stream);
    int result = size <= MAX_POLICY_BYTES && !ferror(stream) ? parse_scope(input, size) : -1;
    free(input);
    return result;
}

static void free_scope(void) {
    for (size_t index = 0; index < root_count; index++) {
        free(roots[index].path);
        for (size_t rule = 0; rule < roots[index].rule_count; rule++) free(roots[index].rules[rule].value);
    }
}

static void json_string(const char *value) {
    putchar('"');
    for (const unsigned char *cursor = (const unsigned char *) value; *cursor; cursor++) {
        if (*cursor == '"' || *cursor == '\\') { putchar('\\'); putchar(*cursor); }
        else if (*cursor < 0x20) printf("\\u%04x", *cursor);
        else putchar(*cursor);
    }
    putchar('"');
}

static void process_event(const struct fanotify_event_metadata *event, int pidfd) {
    if (event->mask & FAN_Q_OVERFLOW) { loss("queue-overflow"); return; }
    if (event->fd < 0 || event->pid == getpid() || !(event->mask & (FAN_OPEN | FAN_ACCESS))) return;
    struct stat file;
    if (fstat(event->fd, &file) != 0 || !S_ISREG(file.st_mode)) return;
    char link[64];
    char path[PATH_MAX + 1];
    snprintf(link, sizeof(link), "/proc/self/fd/%d", event->fd);
    ssize_t size = readlink(link, path, sizeof(path) - 1);
    if (size < 0 || (size_t) size >= sizeof(path) - 1) { loss("io-error"); return; }
    path[size] = '\0';
    const char *deleted = " (deleted)";
    size_t deleted_length = strlen(deleted);
    if (file.st_nlink == 0 && (size_t) size >= deleted_length && strcmp(path + size - deleted_length, deleted) == 0) path[size - deleted_length] = '\0';
    if (!under_root(path)) return;
    uid_t uid;
    unsigned long long first_ticks;
    unsigned long long final_ticks;
    if (!pidfd_alive(pidfd) || start_ticks(event->pid, &first_ticks) != 0 || process_uid(event->pid, &uid) != 0 || start_ticks(event->pid, &final_ticks) != 0 || first_ticks != final_ticks || !pidfd_alive(pidfd)) { loss("process-exited"); return; }
    if (uid != target_uid) return;
    fputs("{\"type\":\"access\",\"path\":", stdout);
    json_string(path);
    printf(",\"access\":\"%s\",\"uid\":%lu,\"process\":{\"bootId\":", event->mask & FAN_ACCESS ? "access" : "open", (unsigned long) uid);
    json_string(boot_id);
    printf(",\"pid\":%ld,\"startTicks\":\"%llu\"}}\n", (long) event->pid, first_ticks);
}

static int parse_arguments(int argc, char **argv) {
    if (argc != 3 || strcmp(argv[1], "--uid") != 0 || *argv[2] == '\0' || strspn(argv[2], "0123456789") != strlen(argv[2])) return -1;
    char *end;
    errno = 0;
    unsigned long uid = strtoul(argv[2], &end, 10);
    if (errno != 0 || *end != '\0' || uid > UINT_MAX) return -1;
    target_uid = (uid_t) uid;
    return getuid() == 0 || target_uid == getuid() ? 0 : -1;
}

int main(int argc, char **argv) {
    if (parse_arguments(argc, argv) != 0 || read_scope(stdin) != 0) { unavailable("io-error"); free_scope(); return 2; }
    if (load_text("/proc/sys/kernel/random/boot_id", boot_id, sizeof(boot_id)) != 0) { unavailable("unsupported"); return 2; }
    boot_id[strcspn(boot_id, "\r\n")] = '\0';
    int notify_fd = fanotify_init(FAN_CLASS_NOTIF | FAN_CLOEXEC | FAN_NONBLOCK | FAN_REPORT_PIDFD, O_RDONLY | O_CLOEXEC | O_LARGEFILE);
    if (notify_fd < 0) {
        unavailable(errno == EPERM || errno == EACCES ? "permission-denied" : errno == ENOSYS || errno == EINVAL ? "unsupported" : "io-error");
        return 2;
    }
    for (size_t index = 0; index < root_count; index++) {
        if (fanotify_mark(notify_fd, FAN_MARK_ADD | FAN_MARK_FILESYSTEM, FAN_OPEN | FAN_ACCESS, AT_FDCWD, roots[index].path) != 0) {
            unavailable(errno == EPERM || errno == EACCES ? "permission-denied" : "io-error");
            close(notify_fd);
            return 2;
        }
    }
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = stop_signal;
    sigemptyset(&action.sa_mask);
    sigaction(SIGTERM, &action, NULL);
    sigaction(SIGINT, &action, NULL);
    puts("{\"type\":\"ready\",\"scopeVersion\":1}");
    fflush(stdout);
    union { char bytes[65536]; max_align_t alignment; } buffer;
    int result = 0;
    int marks_removed = 0;
    while (1) {
        if (stopping && !marks_removed) {
            for (size_t index = 0; index < root_count; index++) {
                if (fanotify_mark(notify_fd, FAN_MARK_REMOVE | FAN_MARK_FILESYSTEM, FAN_OPEN | FAN_ACCESS, AT_FDCWD, roots[index].path) != 0 && errno != ENOENT) loss("io-error");
            }
            marks_removed = 1;
        }
        struct pollfd descriptor = { .fd = notify_fd, .events = POLLIN };
        int ready = poll(&descriptor, 1, stopping ? 0 : 1000);
        if (ready < 0 && errno == EINTR) continue;
        if (ready < 0 || (ready > 0 && !(descriptor.revents & POLLIN))) { unavailable("io-error"); result = 2; break; }
        if (ready == 0) { if (stopping) break; continue; }
        ssize_t length = read(notify_fd, buffer.bytes, sizeof(buffer.bytes));
        if (length < 0 && (errno == EAGAIN || errno == EINTR)) { if (stopping && errno == EAGAIN) break; continue; }
        if (length <= 0) { unavailable("io-error"); result = 2; break; }
        struct fanotify_event_metadata *event = (struct fanotify_event_metadata *) buffer.bytes;
        while (FAN_EVENT_OK(event, length)) {
            int pidfd = -1;
            size_t offset = event->metadata_len;
            if (event->vers != FANOTIFY_METADATA_VERSION || offset < sizeof(*event) || offset > event->event_len) { unavailable("unsupported"); result = 2; stopping = 1; break; }
            while (offset + sizeof(struct fanotify_event_info_header) <= event->event_len) {
                struct fanotify_event_info_header *header = (struct fanotify_event_info_header *) ((char *) event + offset);
                if (header->len < sizeof(*header) || offset + header->len > event->event_len) break;
                if (header->info_type == FAN_EVENT_INFO_TYPE_PIDFD && header->len >= sizeof(struct fanotify_event_info_pidfd)) pidfd = ((struct fanotify_event_info_pidfd *) header)->pidfd;
                offset += header->len;
            }
            process_event(event, pidfd);
            if (event->fd >= 0) close(event->fd);
            if (pidfd >= 0) close(pidfd);
            event = FAN_EVENT_NEXT(event, length);
        }
        if (fflush(stdout) != 0) { result = 2; break; }
    }
    close(notify_fd);
    free_scope();
    return result;
}
#else
int main(void) {
    puts("{\"type\":\"unavailable\",\"reason\":\"unsupported\"}");
    return 2;
}
#endif
