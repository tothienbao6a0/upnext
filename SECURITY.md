# Security

## Reporting

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/tothienbao6a0/upnext/security/advisories/new)
rather than as a public issue. Expect a first response within a week.

## What is in scope

`@upnext/core` does no I/O — no filesystem, no network, no process spawning — so
its attack surface is the data it is handed. Things worth reporting:

- A crafted `MediaRef` that causes the core to behave outside its contract,
  such as a resolution being accepted for something that was not asked for.
- Anything that lets a queue entry escape the runtime's control, or lets a
  consumer mutate queue state through what is supposed to be a read-only view.

The adapters are where the real surface is:

- **`@upnext/adapter-local`** spawns a player process with a path or URL from a
  queue entry. Argument injection or path traversal through a crafted entry is
  in scope.
- **`@upnext/adapter-process`** runs a command the host configures and speaks JSON
  to it. A malicious child escaping the protocol boundary is in scope; the host
  choosing to run an untrusted command is not.

## What is not in scope

- Credentials or tokens. The core never holds them by design — if an adapter
  you wrote leaks one, that is a bug in that adapter.
- The `resolveIntent` callback. It is host-supplied arbitrary code, and it is
  meant to be.
- Anything under `@upnext/core/internal`, which is unsupported.
