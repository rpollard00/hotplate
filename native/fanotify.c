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

static volatile sig_atomic_t stopping = 0;
static char *roots[MAX_ROOTS];
static int root_is_directory[MAX_ROOTS];
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

static int under_root(const char *path) {
    for (size_t index = 0; index < root_count; index++) {
        size_t length = strlen(roots[index]);
        if (strncmp(path, roots[index], length) == 0 && (path[length] == '\0' || (root_is_directory[index] && (path[length] == '/' || (length == 1 && roots[index][0] == '/'))))) return 1;
    }
    return 0;
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
    int has_uid = 0;
    for (int index = 1; index < argc; index += 2) {
        if (index + 1 >= argc) return -1;
        if (strcmp(argv[index], "--uid") == 0) {
            char *end;
            errno = 0;
            unsigned long uid = strtoul(argv[index + 1], &end, 10);
            if (has_uid || errno != 0 || *end != '\0' || end == argv[index + 1] || uid > UINT_MAX) return -1;
            target_uid = (uid_t) uid;
            has_uid = 1;
        } else if (strcmp(argv[index], "--root") == 0) {
            if (root_count >= MAX_ROOTS || argv[index + 1][0] != '/') return -1;
            char *root = realpath(argv[index + 1], NULL);
            struct stat stat;
            if (root == NULL) return -1;
            if (strlen(root) >= PATH_MAX || lstat(root, &stat) != 0 || (!S_ISDIR(stat.st_mode) && !S_ISREG(stat.st_mode))) { free(root); return -1; }
            root_is_directory[root_count] = S_ISDIR(stat.st_mode);
            roots[root_count++] = root;
        } else return -1;
    }
    return has_uid && root_count > 0 && (getuid() == 0 || target_uid == getuid()) ? 0 : -1;
}

int main(int argc, char **argv) {
    if (parse_arguments(argc, argv) != 0) { unavailable("io-error"); return 2; }
    if (load_text("/proc/sys/kernel/random/boot_id", boot_id, sizeof(boot_id)) != 0) { unavailable("unsupported"); return 2; }
    boot_id[strcspn(boot_id, "\r\n")] = '\0';
    int notify_fd = fanotify_init(FAN_CLASS_NOTIF | FAN_CLOEXEC | FAN_NONBLOCK | FAN_REPORT_PIDFD, O_RDONLY | O_CLOEXEC | O_LARGEFILE);
    if (notify_fd < 0) {
        unavailable(errno == EPERM || errno == EACCES ? "permission-denied" : errno == ENOSYS || errno == EINVAL ? "unsupported" : "io-error");
        return 2;
    }
    for (size_t index = 0; index < root_count; index++) {
        if (fanotify_mark(notify_fd, FAN_MARK_ADD | FAN_MARK_FILESYSTEM, FAN_OPEN | FAN_ACCESS, AT_FDCWD, roots[index]) != 0) {
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
    puts("{\"type\":\"ready\"}");
    fflush(stdout);
    union { char bytes[65536]; max_align_t alignment; } buffer;
    int result = 0;
    int marks_removed = 0;
    while (1) {
        if (stopping && !marks_removed) {
            for (size_t index = 0; index < root_count; index++) {
                if (fanotify_mark(notify_fd, FAN_MARK_REMOVE | FAN_MARK_FILESYSTEM, FAN_OPEN | FAN_ACCESS, AT_FDCWD, roots[index]) != 0 && errno != ENOENT) loss("io-error");
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
    for (size_t index = 0; index < root_count; index++) free(roots[index]);
    return result;
}
#else
int main(void) {
    puts("{\"type\":\"unavailable\",\"reason\":\"unsupported\"}");
    return 2;
}
#endif
