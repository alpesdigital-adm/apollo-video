# shellcheck shell=bash
# Hosting decision of 2026-09-19: DigitalOcean only. This local guard performs
# no network requests and no mutations. Declaring a provider is not attestation:
# the operator must independently confirm the real droplet before deploying.
apollo_assert_hosting_policy() {
  local host_name addresses='' address
  host_name="$(hostname)" || {
    printf '%s\n' 'Apollo: unable to identify the local host; refusing operation' >&2
    return 1
  }
  host_name="${host_name,,}"
  case "${host_name%.}" in
    srv1512423|srv1512423.hstgr.cloud|187.77.245.144)
      printf '%s\n' 'Apollo: the former Hostinger host is forbidden; DigitalOcean only' >&2
      return 1
      ;;
  esac
  # Linux reports every local address, including an old host that was renamed.
  # Git Bash may not implement -I; that is acceptable for isolated local tests,
  # never for the production profile.
  if ! addresses="$(hostname -I 2>/dev/null)"; then
    if [[ "${APOLLO_RESOURCE_PROFILE:-}" == 'digitalocean-production' ]]; then
      printf '%s\n' 'Apollo: local addresses cannot be verified; refusing production operation' >&2
      return 1
    fi
  fi
  for address in ${addresses}; do
    if [[ "${address}" == '187.77.245.144' ]]; then
      printf '%s\n' 'Apollo: the former Hostinger address is forbidden; DigitalOcean only' >&2
      return 1
    fi
  done
  case "${APOLLO_RESOURCE_PROFILE:-}" in
    digitalocean-production)
      # Deployment runs via SSH on the confirmed droplet, not through a remote
      # Docker endpoint inherited from an earlier hosting environment.
      if [[ "${DOCKER_CONTEXT:-default}" != 'default' || "${DOCKER_HOST:-unix:///var/run/docker.sock}" != 'unix:///var/run/docker.sock' ]]; then
        printf '%s\n' 'Apollo: production requires the local Docker endpoint on the confirmed DigitalOcean droplet' >&2
        return 1
      fi
      if [[ -z "${addresses//[[:space:]]/}" ]]; then
        printf '%s\n' 'Apollo: local addresses are empty; refusing production operation' >&2
        return 1
      fi
      if [[ "${APOLLO_HOSTING_PROVIDER:-}" != 'digitalocean' ]]; then
        printf '%s\n' 'Apollo: production requires APOLLO_HOSTING_PROVIDER=digitalocean' >&2
        return 1
      fi
      # An unset DOCKER_CONTEXT does not mean "default": docker context use
      # persists a selection in the user's config. Pin both values for every
      # child process without changing that user's saved configuration.
      export DOCKER_CONTEXT=default
      export DOCKER_HOST=unix:///var/run/docker.sock
      ;;
    isolated-ci|local-dev)
      case "${APOLLO_HOSTING_PROVIDER:-local}" in
        local|digitalocean) ;;
        *) printf '%s\n' 'Apollo: only local/CI isolation or DigitalOcean is permitted' >&2; return 1 ;;
      esac
      ;;
    '')
      printf '%s\n' 'Apollo: APOLLO_RESOURCE_PROFILE is required; production is DigitalOcean only' >&2
      return 1
      ;;
    *)
      printf '%s\n' 'Apollo: APOLLO_RESOURCE_PROFILE must be isolated-ci, local-dev or digitalocean-production; old production profiles are retired' >&2
      return 1
      ;;
  esac
  case "${PGHOST:-}" in
    srv1512423|srv1512423.hstgr.cloud|187.77.245.144)
      printf '%s\n' 'Apollo: PostgreSQL on the former Hostinger host is forbidden' >&2
      return 1
      ;;
  esac
}
