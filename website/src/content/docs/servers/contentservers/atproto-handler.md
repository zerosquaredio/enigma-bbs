---
title: AT Protocol (Bluesky) Login
description: "Let callers log in with their Bluesky or other AT Protocol account."
sidebar:
    order: 8
---
AT login lets callers log in with an account on [Bluesky](https://bsky.app) or any other [AT Protocol](https://atproto.com) service, instead of a username and password. The caller enters their handle (for example `alice.bsky.social`) in the terminal, opens the link the BBS shows in a web browser, and approves the login at their own account host. The terminal then continues as it would after a password login.

The BBS learns only who the caller is. It asks for the base `atproto` OAuth scope, which proves identity and nothing more: the BBS can never post or change anything in the caller's account.

The pieces are [core/atproto/](https://github.com/NuSkooler/enigma-bbs/blob/master/core/atproto/), the `atproto_login` menu module ([atproto_login.js](https://github.com/NuSkooler/enigma-bbs/blob/master/core/atproto_login.js)), and the `atProto` web handler ([atproto.js](https://github.com/NuSkooler/enigma-bbs/blob/master/core/servers/content/web_handlers/atproto.js)).

## How It Works
* **Users are tied to the account's DID, not its handle.** Every AT account has a permanent identifier, its DID (such as `did:plc:xyjderwsx2kwmpuxgij6eyln`). The BBS stores it as the user's `atproto_did` property and finds the user by it, so a caller who changes their handle keeps their BBS account, and someone who takes over an old handle does not get the previous owner's account.
* **New callers apply after logging in.** An AT account with no user yet goes on to the new user application, with its handle shown and the account already proven, so the board knows the account is real before anyone fills in a form. The username field starts with the handle's first part (`alice` for `alice.bsky.social`), with a number added if that name is taken (`alice2`) and reserved names (`users.badUserNames`, `users.newUserNames`) skipped; the caller may change it. The handle is kept for display as `atproto_handle` and refreshed at each login.
* **No password.** The application asks for none. Users created this way get a random password nobody knows, so password login is closed to them unless they set a password of their own.
* **Everything else is a normal login.** Account status (inactive, disabled, locked), `users.requireActivation`, groups, 2FA and "already logged in" all apply as for password logins.
* **The login is checked against the handle the caller typed.** Whoever opens the link chooses which account approves it, so the BBS accepts the approval only if it comes from the account the caller named in the terminal.
* **Secure connections only.** AT login works over SSH, `wss://` and TLS. Telnet callers who choose it are told to connect with SSH instead (`atProto.login.secureConnectionsOnly`).

## Requirements
* The [Web Server](./web-server.md) enabled. Callers' browsers must be able to reach it: the link the terminal shows, and the redirect back from their account host, both go to it.
* For real use (public mode, below), the web server reachable at an `https://` address: directly, behind a reverse proxy, or through a tunnel.
* At least one secure login server: [SSH](../loginservers/ssh.md) or [WebSocket](../loginservers/websocket.md) over `wss://`.

## Configuration
### Enabling AT Login
Turn on AT Protocol support, and the web handler that serves its routes:

```hjson
atProto: {
    enabled: true
    oauth: {
        clientMode: public
    }
    login: {
        //  your own DID, if AT login is how you will create the sysop account
        rootDid: ""
    }
}

contentServers: {
    web: {
        //  the https:// address callers' browsers use, if it differs from
        //  the one ENiGMA½ would build from domain and port
        overrideUrlPrefix: "https://bbs.example.com"

        handlers: {
            atProto: {
                enabled: true
            }
        }
    }
}
```

With `atProto.enabled` off (the default), nothing AT related is loaded: the OAuth library is never imported and no routes are added. The empty `atproto` database is still created, as the `activitypub` one is.

### Configuration Keys
| Key | Description | Default |
|-----|-------------|---------|
| `atProto.enabled` | Boolean. Load AT Protocol support. | `false` |
| `atProto.oauth.clientMode` | `loopback` or `public`; see [Client Modes](#client-modes). | `loopback` |
| `atProto.login.allowNewUsers` | Boolean. Let an AT account with no user yet apply for one after logging in. When `false`, only users already tied to a DID can use AT login. `general.closedSystem` also stops new users. | `true` |
| `atProto.login.secureConnectionsOnly` | Boolean. Refuse AT login on insecure connections such as telnet. | `true` |
| `atProto.login.rootDid` | String. The only DID that may become the first user (root, a sysop) through AT login; see [The First User](#the-first-user). | `""` |
| `atProto.login.handoffTimeoutSeconds` | Number. How long the login screen waits for approval in the browser. | `300` |
| `contentServers.web.handlers.atProto.enabled` | Boolean. Serve the AT login routes. Needs `atProto.enabled`. | `false` |
| `contentServers.web.rateLimits.handoffGet` | Requests per address to the login links. | 20 per 10 minutes |
| `contentServers.web.rateLimits.atProtoCallback` | Requests per address to the OAuth callback. | 20 per 10 minutes |

### Client Modes
Account hosts need to know which application is asking for a login. ENiGMA½ can identify itself two ways:

* **`public`**, for real use. The BBS is identified by a small document it serves at `/_enig/atproto/client-metadata.json` on its own `https://` address, and proves who it is with a signing key. On first start in this mode, ENiGMA½ makes the key and saves it as `atproto_oauth_key.json` in `paths.security` (readable by the BBS's user only), and serves its public half at `/_enig/atproto/jwks.json`. Callers see your `general.boardName` on the approval page.

  Every address comes from the web server's base URL, the same one used for the links the terminal shows. It must be `https://`. Behind a reverse proxy or tunnel, set `contentServers.web.overrideUrlPrefix` to the public address. If the base URL changes, so does the BBS's identity to account hosts; callers are simply asked to approve it again at their next AT login.

* **`loopback`**, for development only. It needs no public address and no key, but the account host sends the browser back to `http://127.0.0.1:<port>`, as AT's rules for development clients require. That works only when the browser runs on the BBS's own machine, or reaches it through an SSH tunnel such as `ssh -L 8080:127.0.0.1:8080 bbs-host`.

:::caution
Keep `atproto_oauth_key.json` and the `atproto` database private and backed up, as you would the SSH host key. The database holds callers' OAuth sessions. Losing the key is not fatal: delete the file and a new one is made at the next start.
:::

### The First User
User #1 is root and a member of `sysops`. On a new board, the first person to apply would otherwise get that, so AT login never lets anyone apply as the first user unless their DID is `atProto.login.rootDid`. With `rootDid` empty, create the sysop account the usual way (`apply`) and use AT login for everyone else.

To become the sysop through AT login, look up your DID (open `https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=<your handle>` in a browser), set it as `rootDid`, log in with AT login, and fill in the application.

### Offering It to Callers
The login menu template includes an `atprotoLogin` menu and a commented out "bluesky login" option on the login matrix. Uncomment the option in your login menu file:

```hjson
{
    text: bluesky login
    data: atproto
}
```

The menu is not limited with `acs: SC`, which would refuse it without a word: the screen itself tells callers on insecure connections to use SSH, following `atProto.login.secureConnectionsOnly`.

SSH callers authenticate before they reach the matrix. To offer AT login to SSH callers who connect as a new user name (such as `new`), point `sshConnectedNewUser`'s `next` at `matrix`, or straight at `atprotoLogin`.

The login screen uses the `ATPROTOLOGIN` art with two views: `ET1`, where the caller types their handle, and `MT2`, for instructions, the link to open and progress.

An account with no user yet is sent to the menu named by the `atprotoLogin` menu's `config.newUserApplication`: in the template, `atprotoApplication` in the new user menu file. It is the `nua` module with `config.atProto` set, and works as `newUserApplication` but has no password fields. It uses the `ATNUA` art, which adds `TL13` to show the caller's handle. It can only be reached from AT login; opened any other way, it returns to the previous menu. The proven account is kept for 30 minutes while the caller fills it in.

### AT-Only Boards
`users.allowedAuthFactor1Types` lists the login types the board accepts: `password`, `sshPubKey` (SSH keys), `tlsClientAuth` and `atproto`. All four are accepted by default. To have callers log in with AT login only:

```hjson
users: {
    allowedAuthFactor1Types: [ "atproto" ]
}
```

* Password and SSH key logins are refused everywhere: the login menu, SSH, NNTP and the REST API. A refused login type is not counted as a failed login, so it never locks an account.
* The password application ("apply", or SSH as a new user name) sends callers to AT login instead, through the application menu's `config.atProtoLogin`, so they prove their account and then apply with no password. Without `atProtoLogin`, or with `atproto` left out too, they are shown the `loginAttemptLoginTypeNotAllowed` menu (the `LOGINTYPE` art), as are callers who choose "login".
* Menus are not changed for you: you may want to remove the `login` option from your login matrix.
* Users who already have an SSH key or password cannot use it while its type is left out; add the type back to let them.

Leaving `atproto` out turns AT login off the same way, without changing `atProto.enabled`.

As with other lists in `config.hjson`, `allowedAuthFactor1Types` replaces the default list rather than adding to it.

## Routes
| Route | Purpose |
|-------|---------|
| `/_enig/handoff/<code>` | The short link shown in the terminal. Sends the browser on to the caller's account host. |
| `/_enig/atproto/callback` | Where the account host sends the browser after the caller approves or denies. |
| `/_enig/atproto/client-metadata.json` | Public mode only: identifies the BBS to account hosts. |
| `/_enig/atproto/jwks.json` | Public mode only: the public half of the signing key. |

Behind a reverse proxy, forward `/_enig/handoff/` and `/_enig/atproto/`.
