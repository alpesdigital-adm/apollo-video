/* CI-only, unprivileged Node-API 8. No libuv/V8/private Node ABI, exec or FFI.
 * A token owns one CLOEXEC pidfd; JavaScript can never supply a raw descriptor.
 */
#define _GNU_SOURCE
#define NAPI_VERSION 8
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <sys/syscall.h>
#include <unistd.h>
#ifndef __linux__
#error Linux pidfd prerequisites required
#endif
#if !defined(SYS_pidfd_open) || !defined(SYS_pidfd_send_signal)
#error Linux pidfd syscall headers required
#endif

typedef struct { int fd; } owned_pidfd;
static const napi_type_tag PIDFD_TAG = { UINT64_C(0x53e785a4d8cf40f2), UINT64_C(0x85a9648299d072f1) };

static napi_value api_error(napi_env env, const char *code, const char *message) {
  napi_throw_error(env, code, message);
  return NULL;
}

static const char *errno_code(int value) {
  switch (value) {
    case ESRCH: return "ESRCH";
    case EPERM: return "EPERM";
    case EACCES: return "EACCES";
    case ENOSYS: return "ENOSYS";
    case EBADF: return "EBADF";
    case EINVAL: return "EINVAL";
    case EMFILE: return "EMFILE";
    case ENFILE: return "ENFILE";
    case ENOMEM: return "ENOMEM";
    case EINTR: return "EINTR";
    default: return "ERR_PIDFD_SYSCALL";
  }
}

static void finalize_pidfd(napi_env env, void *data, void *hint) {
  (void) env; (void) hint;
  owned_pidfd *value = data;
  if (value != NULL) {
    int fd = value->fd;
    value->fd = -1;
    if (fd >= 0) close(fd); /* Never retry Linux close(EINTR) on a reused fd. */
    free(value);
  }
}

static owned_pidfd *unwrap_pidfd(napi_env env, napi_value token) {
  napi_valuetype type;
  bool tagged = false;
  void *data = NULL;
  if (napi_typeof(env, token, &type) != napi_ok || type != napi_object ||
      napi_check_object_type_tag(env, token, &PIDFD_TAG, &tagged) != napi_ok || !tagged ||
      napi_unwrap(env, token, &data) != napi_ok || data == NULL) {
    napi_throw_type_error(env, "ERR_PIDFD_TOKEN", "Expected an opaque owned pidfd token");
    return NULL;
  }
  return data;
}

static napi_value open_pidfd(napi_env env, napi_callback_info info) {
  napi_value args[2], token;
  size_t argc = 2;
  double number;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_double(env, args[0], &number) != napi_ok || !isfinite(number) ||
      number < 1 || number > INT_MAX || floor(number) != number)
    return api_error(env, "ERR_PIDFD_PID", "Expected exactly one positive integer PID");
  int fd = (int) syscall(SYS_pidfd_open, (int) number, 0);
  if (fd < 0) return api_error(env, errno_code(errno), "pidfd_open failed");
  int flags = fcntl(fd, F_GETFD);
  if (flags < 0 || !(flags & FD_CLOEXEC)) {
    close(fd);
    return api_error(env, "ERR_PIDFD_CLOEXEC", "Kernel pidfd must be CLOEXEC");
  }
  owned_pidfd *value = malloc(sizeof(*value));
  if (value == NULL) { close(fd); return api_error(env, "ENOMEM", "pidfd token allocation failed"); }
  value->fd = fd;
  if (napi_create_object(env, &token) != napi_ok || napi_type_tag_object(env, token, &PIDFD_TAG) != napi_ok ||
      napi_wrap(env, token, value, finalize_pidfd, NULL, NULL) != napi_ok) {
    close(fd); free(value);
    return api_error(env, "ERR_PIDFD_NAPI", "pidfd token creation failed");
  }
  return token;
}

static napi_value signal_pidfd(napi_env env, napi_callback_info info) {
  napi_value args[3], result;
  size_t argc = 3, length = 0;
  char requested[8];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 2)
    return api_error(env, "ERR_PIDFD_ARGUMENT", "Expected token and fixed containment signal");
  owned_pidfd *value = unwrap_pidfd(env, args[0]);
  if (value == NULL) return NULL;
  if (value->fd < 0) return api_error(env, "ERR_PIDFD_CLOSED", "pidfd token is closed");
  if (napi_get_value_string_utf8(env, args[1], NULL, 0, &length) != napi_ok || length != 7 ||
      napi_get_value_string_utf8(env, args[1], requested, sizeof(requested), &length) != napi_ok)
    return api_error(env, "ERR_PIDFD_SIGNAL", "Only SIGTERM and SIGKILL are allowed");
  int signum;
  if (strcmp(requested, "SIGTERM") == 0) signum = SIGTERM;
  else if (strcmp(requested, "SIGKILL") == 0) signum = SIGKILL;
  else return api_error(env, "ERR_PIDFD_SIGNAL", "Only SIGTERM and SIGKILL are allowed");
  if (syscall(SYS_pidfd_send_signal, value->fd, signum, NULL, 0) < 0)
    return api_error(env, errno_code(errno), "pidfd_send_signal failed");
  if (napi_get_boolean(env, true, &result) != napi_ok) return api_error(env, "ERR_PIDFD_NAPI", "signal result creation failed");
  return result;
}

static napi_value close_pidfd(napi_env env, napi_callback_info info) {
  napi_value args[2], result;
  size_t argc = 2;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1)
    return api_error(env, "ERR_PIDFD_ARGUMENT", "Expected exactly one owned token");
  owned_pidfd *value = unwrap_pidfd(env, args[0]);
  if (value == NULL) return NULL;
  bool was_open = value->fd >= 0;
  int fd = value->fd;
  value->fd = -1; /* Idempotent, including errno and finalizer paths. */
  if (fd >= 0 && close(fd) < 0) return api_error(env, errno_code(errno), "pidfd close failed");
  if (napi_get_boolean(env, was_open, &result) != napi_ok) return api_error(env, "ERR_PIDFD_NAPI", "close result creation failed");
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor functions[] = {
    { "open", NULL, open_pidfd, NULL, NULL, NULL, napi_default, NULL },
    { "signal", NULL, signal_pidfd, NULL, NULL, NULL, napi_default, NULL },
    { "close", NULL, close_pidfd, NULL, NULL, NULL, napi_default, NULL },
  };
  if (napi_define_properties(env, exports, 3, functions) != napi_ok)
    return api_error(env, "ERR_PIDFD_NAPI", "pidfd exports creation failed");
  return exports;
}
NAPI_MODULE(apollo_ci_pidfd, initialize)
