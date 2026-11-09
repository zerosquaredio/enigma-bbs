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
| `atProto.login.allowNewUsers` | Boolean. Let an AT account with no user yet apply for one after logging in. When `false` (or with `general.closedSystem`), the board is invitation only: only [invites and invite codes](#admission) admit new users. | `true` |
| `atProto.admission.policy` | Array. How new AT users are admitted; see [Admission](#admission). | `["open"]` |
| `atProto.admission.provisionalGroup` | String. Group for applicants the policy doesn't admit, instead of refusing them. | `""` |
| `atProto.login.secureConnectionsOnly` | Boolean. Refuse AT login on insecure connections such as telnet. | `true` |
| `atProto.login.rootDid` | String. The only DID that may become the first user (root, a sysop) through AT login; see [The First User](#the-first-user). | `""` |
| `atProto.login.handoffTimeoutSeconds` | Number. How long the login screen waits for approval in the browser. | `300` |
| `contentServers.web.handlers.atProto.enabled` | Boolean. Serve the AT login routes. Needs `atProto.enabled`. | `false` |
| `contentServers.web.rateLimits.handoffGet` | Requests per address to the login links. | 20 per 10 minutes |
| `contentServers.web.rateLimits.atProtoCallback` | Requests per address to the OAuth callback. | 20 per 10 minutes |
| `atProto.publishing.enabled` | Boolean. Let a sysop connect [the board's own account](#the-boards-own-account). | `false` |
| `atProto.publishing.listing` | Object. The board's listing: `description`, `tags`, `rules`, `howToJoin`, `hours`, `deriveEndpoints`, `endpoints`, `sysopDid`. | (empty) |
| `atProto.publishing.minPostIntervalSeconds` | Number. At most one announcement this often. | `60` |
| `atProto.publishing.postLangs` | Array. Languages announcements are written in. | `["en"]` |
| `atProto.publishing.nsidPrefix` | String. Prefix of the published record names. | `nexus.cyberspace.dev` |
| `atProto.webSignIn.enabled` | Boolean. Offer [web sign-in](#web-sign-in) at `/_enig/signin`. | `false` |
| `atProto.webSignIn.sessionDays` | Number. How long a browser stays signed in. | `30` |
| `atProto.webSignIn.allowedOrigins` | Array. Web origins, such as `"https://bbs.example.com"`, whose pages may use web sign-in besides the board's own web address. | `[]` |
| `loginServers.webSocket.firstMenuSignedIn` | String. The first menu for callers signed in on the web. | `webSignInConnected` |
| `contentServers.web.rateLimits.atProtoSignIn` | Requests per address to the web sign-in pages. | 60 per 10 minutes |

### Client Modes
Account hosts need to know which application is asking for a login. ENiGMA½ can identify itself two ways:

* **`public`**, for real use. The BBS is identified by a small document it serves at `/_enig/atproto/client-metadata.json` on its own `https://` address, and proves who it is with a signing key. On first start in this mode, ENiGMA½ makes the key and saves it as `atproto_oauth_key.json` in `paths.security` (readable by the BBS's user only), and serves its public half at `/_enig/atproto/jwks.json`. Callers see your `general.boardName` on the approval page.

  Every address comes from the web server's base URL, the same one used for the links the terminal shows. It must be `https://`. Behind a reverse proxy or tunnel, set `contentServers.web.overrideUrlPrefix` to the public address. If the base URL changes, so does the BBS's identity to account hosts; callers are simply asked to approve it again at their next AT login.

* **`loopback`**, for development only. It needs no public address and no key, but the account host sends the browser back to `http://127.0.0.1:<port>`, as AT's rules for development clients require. That works only when the browser runs on the BBS's own machine, or reaches it through an SSH tunnel such as `ssh -L 8080:127.0.0.1:8080 bbs-host`.

:::caution
Keep `atproto_oauth_key.json` and the `atproto` database private and backed up, as you would the SSH host key. The database holds callers' OAuth sessions. Losing the key is not fatal: delete the file and a new one is made at the next start.
:::

### The First User
User #1 is root and a member of `sysops`. On a new board, the first person to apply would otherwise get that, so AT login never lets anyone apply as the first user unless their DID is `atProto.login.rootDid`. With `rootDid` empty, create the sysop account the usual way (`apply`) and use AT login for everyone else; you can link your own Bluesky account to it later (see [Linking Existing Accounts](#linking-existing-accounts)).

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

AT login over SSH takes a browser each time. After it, callers are offered the SSH key their client connected with, so next time they can connect as their user name with that key and skip the browser (see [Offering the Key a Caller Connected With](../loginservers/ssh.md#offering-the-key-a-caller-connected-with)). They can also add a key later with the `SSH` command from the main menu.

The login screen uses the `ATPROTOLOGIN` art with two views: `ET1`, where the caller types their handle, and `MT2`, for instructions, the link to open and progress.

An account with no user yet is sent to the menu named by the `atprotoLogin` menu's `config.linkAccount`, if set (see [Linking Existing Accounts](#linking-existing-accounts)), and from there, or straight away without it, to the one named by `config.newUserApplication`: in the template, `atprotoApplication` in the new user menu file. It is the `nua` module with `config.atProto` set, and works as `newUserApplication` but has no password fields. It uses the `ATNUA` art, which adds `TL13` to show the caller's handle. It can only be reached from AT login; opened any other way, it returns to the previous menu. The proven account is kept for 30 minutes while the caller fills it in.

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
* Users who already have an SSH key or password cannot use it while its type is left out; add the type back to let them. To let AT users log in over SSH with a key, list `sshPubKey` too: `[ "atproto", "sshPubKey" ]`.

Leaving `atproto` out turns AT login off the same way, without changing `atProto.enabled`.

As with other lists in `config.hjson`, `allowedAuthFactor1Types` replaces the default list rather than adding to it.

### Admission
`atProto.admission.policy` decides who may join when someone logs in with a Bluesky account that has no user here yet. It lists **verifiers** in order; the first that admits the applicant decides their groups and account status. Users who already exist are never checked again, so tightening the policy leaves them as they are.

| Verifier | Admits | Account | Groups |
|----------|--------|---------|--------|
| `open` | Anyone | as `users.requireActivation` says | `users.defaultGroups` |
| `invite` | An account the sysop invited | active | the invite's |
| `invite-code` | Anyone who enters a valid invite code | active | the code's |
| `sysop-approval` | Anyone | inactive, until the sysop activates it | `users.defaultGroups` |

An admitted user also joins `verified-<verifier>` (for example `verified-invite`), so access rules can tell how they got in, such as `GM[verified-invite]`.

```hjson
atProto: {
    admission: {
        //  invited people first, then anyone with a code, then the rest wait for approval
        policy: [ "invite", "invite-code", "sysop-approval" ]
    }
}
```

Put `invite` and `invite-code` before `open` or `sysop-approval`, or they never get the chance to apply their groups. The policy is read for each application, so changes take effect without a restart. As with other lists in `config.hjson`, it replaces the default rather than adding to it.

**Invitation only.** With `atProto.login.allowNewUsers: false` (or `general.closedSystem`), only `invite` and `invite-code` admit; callers without one are told the board is invitation only. `atProto.login.rootDid` still becomes the first user whatever the policy.

**Invites** are made for one Bluesky account, so there is nothing secret to pass on: only that account can use it, once. The board does not send them: tell the person yourself, and they log in with Bluesky and apply.

```shell
./oputil.js atproto invite add alice.bsky.social --groups users,friends --days 14
./oputil.js atproto invite list
./oputil.js atproto invite revoke 3
```

**Invite codes** can be handed to anyone. Each has a number of uses (one by default), an optional expiry and its own groups. `oputil` shows a new code once: only a hash of it is kept, so it can't be shown again; `list` shows each by its last four characters.

```shell
./oputil.js atproto invite-code add --uses 10 --days 30
./oputil.js atproto invite-code list
./oputil.js atproto invite-code revoke 2
```

When the policy includes `invite-code`, the AT application form (`atprotoApplication`, `ATNUA` art) shows an "Invite code" field, `ET9` with its label `TL10`; otherwise the label is blank and the field is skipped. A code is checked when the applicant leaves the field, and used up only once their user is created; two applicants can't both have the last use of a code. Set the label's text with the menu's `config.inviteCodeLabel`.

**Provisional access.** With `atProto.admission.provisionalGroup` set, say to `provisional`, applicants no verifier admits are not refused: they become active users in that group only, without `users.defaultGroups`. Areas in the default configuration need `GM[users]`, so they see only what you open to them, for example a welcome board with `GM[users,provisional]`. Menus have no access check by default, so add one (`acs: GM[users]`) to menus provisional users should not reach, such as doors or the user list. Promote them with `./oputil.js user group USERNAME +users`, or let ACS do it, for example `GM[users] | (GM[provisional] & AA7 & NP5)`: provisional for a week with five posts. A board closed to new users admits nobody provisionally.

### Linking Existing Accounts
Users who had an account before AT login can link their Bluesky account to it, so either login works and they keep their messages, files and settings. A DID is linked to one user at most. There are three ways:

* **At login.** In the login menu template, an AT login with no user linked yet goes to `atprotoLinkAccount` (the `atproto_link_account` module, `ATLINK` art), named by the `atprotoLogin` menu's `config.linkAccount`. The caller is asked whether they already have an account here: yes takes its user name and password, once, and links it; no goes on to apply as a new user. A wrong password counts as a failed login, as at the password login, and too many end the call. Linking replaces any Bluesky account the user had linked before. It works on [AT-only boards](#at-only-boards) too: the caller ends up logged in through AT login, not a password login. Users with 2FA are told to log in with their password and link from their settings instead, since a password alone can't prove them. Remove `config.linkAccount` to send callers straight to the application, as before.
* **From user settings.** The `userAtProtoConfig` menu (the `atproto_account_config` module, `ATCFG` art) in the main menu template, reached with the `AT` command once you uncomment it, links the logged-in user's Bluesky account, approved in a browser as for AT login, or unlinks it. Unlinking needs the user's password, unless they have a saved SSH key, so they keep a way to log in. Users created by AT login have a password nobody knows: they set one, or an SSH key, before unlinking. Its views are `ET1` (handle), `MT2` (status), `ET3` (password, for unlinking) and `HM4` (`link`, `unlink`, `cancel`).
* **By the sysop**, with `./oputil.js user atproto USERNAME DID` (or `clear` to unlink); see [oputil](../../admin/oputil.md). Nothing proves the DID belongs to the user, so look it up yourself. `./oputil.js user info USERNAME` shows a user's linked DID and handle.

The `atprotoLinkAccount` menu's views are `TL1` (the caller's handle), `TM2` (`yes` / `no`, also answered with `Y` and `N`), `ET3` and `ET4` (user name and password) and `TL5` (status). ESC goes back. Its `config` names the same account state menus as `atprotoLogin`, plus `newUserApplication`.

### Web Sign-In
With [enig-term](../loginservers/enig-term.md), callers can sign in with Bluesky once on a page of your web server, and from then on reach the board from their browser without a login prompt.

* `/_enig/signin` has a "Sign in with Bluesky" form. The caller approves in the same tab, and is sent on to enig-term at `/_enig/ws-term/?connect=1`, which connects and logs them in.
* Later visits to enig-term log in at once. The start page then offers "Continue to the board" and "Sign out". Logging off the board does not sign the browser out.
* The browser keeps a cookie for `atProto.webSignIn.sessionDays`. The board stores only a hash of it, in the `atproto` database, so sessions survive restarts.
* Each time enig-term connects with the cookie, the board refreshes the caller's AT session with their account host. If they have revoked the board's access there (for Bluesky, in their account's settings), that fails and the browser is signed out.
* The login itself is AT login's: a user linked to the account is logged in, an account with no user yet goes on to link or apply, and account states, 2FA, `allowedAuthFactor1Types` and `atProto.login.secureConnectionsOnly` all apply. If the login can't be done, the caller gets the usual login screen.

To turn it on:

```hjson
atProto: {
    webSignIn: {
        enabled: true
    }
}
```

**Requirements**

* AT login, with the `atProto` web handler.
* enig-term [installed](../loginservers/enig-term.md#installing) and served from the **same host name** as the start page, so the browser sends the cookie on its WebSocket connection; ports may differ. Behind a proxy or tunnel, put the web server and the WebSocket endpoint under one host name (for example `bbs.example.com` and `wss://bbs.example.com/wss`).
* `https://` for the web server (browsers keep the cookie only from secure pages), apart from development on `127.0.0.1`.

**Security.** Browsers send cookies along with WebSocket connections that other sites' pages open, so the cookie only counts when the connection comes from one of the board's own pages: its `Origin` must be the web server's address, loopback mode's `http://127.0.0.1:<port>`, or one of `atProto.webSignIn.allowedOrigins`. Connections from anywhere else are accepted as before, but must log in as usual, so other web terminals keep working. The same check applies to the sign-in and sign-out forms. The cookie is `HttpOnly`, `Secure` and `SameSite=Lax`.

**The menu.** Signed-in callers start at the menu named by `loginServers.webSocket.firstMenuSignedIn`, `webSignInConnected` in the login menu template, instead of `telnetConnected`. It is the `atproto_web_sign_in` module, with the same `config` and `next` as `atprotoLogin`, plus `fallback`: the menu to go to when the login can't be done, `matrix` in the template. It has no views; its art (`CONNECT` in the template) is optional.

**Development.** In loopback mode the start page and enig-term must be opened on `http://127.0.0.1`. With the board on another machine, tunnel both ports, for example `ssh -L 8080:127.0.0.1:8080 -L 8810:127.0.0.1:8810 bbs-host`, enable the plain `ws` listener, and set `contentServers.web.wsTerm.endpoint` to `ws://127.0.0.1:8810` (enig-term allows `ws://` for loopback addresses). Over plain `ws://` the connection is not secure, so `atProto.login.secureConnectionsOnly` must be `false` for the sign-in to log callers in.

### The Board's Own Account
A board can have its own Bluesky (AT) account, separate from the sysop's personal one, which publishes:

* a **listing**: the board's name, description, how to connect, how to join, and its hours, for hubs and directories to show;
* a **status**: the sysop's notice, such as planned maintenance;
* **announcements**: ordinary Bluesky posts, seen by the account's followers.

Nothing about members is ever published. Turn it on with:

```hjson
atProto: {
    publishing: {
        enabled: true
        listing: {
            description: "Door games and ANSI art since 1994"
            tags: [ "doors", "ansi" ]
            howToJoin: "Log in with Bluesky and apply"
            //  for a board that is not always up
            hours: {
                timezone: "America/Los_Angeles"
                weekly: [ { days: [ "fri", "sat" ], from: "19:00", to: "23:00" } ]
                note: "Weekend evenings"
            }
        }
    }
}
```

then restart, and connect the account from the **board account** menu (`boardAtProtoAccount` in the main menu template, behind a commented out `BA` command): enter the board account's handle and approve it in a browser, as for Bluesky login. The board asks only for what it needs: to write its listing and status records, to create posts, and to upload images. Members are still asked for proof of identity alone. The board keeps this write session apart from members' logins, so the account may also be someone's login here.

The menu is for sysops: its `config.acs` is `GM[sysops]` in the template. Change it to `ID1` to let only the root user (#1) in. It shows the connected account, and can post an announcement, publish the listing now, or disconnect the account (which revokes the board's access; its records stay until removed).

**The listing** is written when the account is connected, at startup, daily, and soon after `config.hjson` changes, and only when it differs from what was last written. Its ways to connect are taken from the enabled servers (the web sign-in page, or enig-term; SSH; telnet) when their addresses are public, plus any in `listing.endpoints`; set `listing.deriveEndpoints: false` to list only those. Its admission policy is `atProto.admission.policy`. Private and loopback addresses are never listed.

**From the command line**, using the stored session, whether or not the board is running:

```shell
./oputil.js atproto board                       # which account, and when it last published
./oputil.js atproto publish                     # the listing, if it changed (--force: anyway)
./oputil.js atproto status maintenance --message "New hardware" --until 2026-12-01T20:00Z
./oputil.js atproto post "Door games night this Friday!"
```

Posts are plain text, up to 300 characters, with web links made clickable, and at most one per `minPostIntervalSeconds`. They are public and effectively permanent: Bluesky honors deletes, but copies may persist.

**Record names.** The listing and status are custom AT records, which the Bluesky app ignores. While their layout is a draft they are named under `nexus.cyberspace.dev` (`nexus.cyberspace.dev.leaf.listing`, `.leaf.status`); `atProto.publishing.nsidPrefix` changes the prefix once the layout is final. Published names are permanent.

## Behind a Proxy, Tunnel or Hub
A board often isn't reached at its own address: it sits behind a reverse proxy (nginx, Caddy), a tunnel (Cloudflare Tunnel, ngrok, frp), or a hub that carries boards on home connections. AT login, web sign-in and the board's listing need to know the address callers actually use, and that their connections arrived over `https`:

```hjson
contentServers: {
    web: {
        //  the address callers use
        overrideUrlPrefix: "https://bbs.example.com"
        //  visitors' addresses come from the proxy's X-Forwarded-For
        proxied: true
    }
}
loginServers: {
    webSocket: {
        //  a connection the proxy took over https counts as secure
        proxied: true
    }
}
atProto: {
    oauth: {
        clientMode: public
    }
}
```

* **The public address** (`overrideUrlPrefix`) is used for everything callers see or follow: the links the terminal shows, the board's identity to account hosts in public mode, the origin web sign-in accepts, and the web address in the board's listing.
* **The proxy must say how the caller connected.** It sends `X-Forwarded-For` with the caller's address and `X-Forwarded-Proto: https`. With `loginServers.webSocket.proxied`, a WebSocket connection whose proxy says `https` counts as secure, so AT login is offered over it. These headers are believed only from `trustedProxies` ([Reverse Proxies](./web-server.md#reverse-proxies)), whose default covers the same machine and the LAN, so a proxy or tunnel agent on the board's own machine needs no entry.
* **Forward** the [routes](#routes) below, and the WebSocket path for enig-term. Web sign-in needs the start page, enig-term and the WebSocket under the **one host name** in `overrideUrlPrefix`.
* **enig-term** can be served by the board (set `contentServers.web.wsTerm.endpoint` to the public `wss://` address), or by the proxy or hub itself at `/_enig/ws-term/`, the path web sign-in sends the browser to.
* **The listing** (with [the board's own account](#the-boards-own-account)) gives the public address for the web. SSH and telnet aren't carried by a web proxy, so they are listed at `contentServers.web.domain`, the board's own name, and only when that is a public name: a board at home with a LAN address lists none, unless you give them in `atProto.publishing.listing.endpoints`.

**Through a hub,** `overrideUrlPrefix` is the board's address on the hub (such as `https://coolbbs.hub.example`). The hub's tunnel agent runs next to the board and connects to it on `127.0.0.1`, which the default `trustedProxies` covers, and its generated config sets `X-Forwarded-Proto` for the board. The hub serves enig-term itself.

## Routes
| Route | Purpose |
|-------|---------|
| `/_enig/handoff/<code>` | The short link shown in the terminal. Sends the browser on to the caller's account host. |
| `/_enig/atproto/callback` | Where the account host sends the browser after the caller approves or denies. |
| `/_enig/atproto/client-metadata.json` | Public mode only: identifies the BBS to account hosts. |
| `/_enig/atproto/jwks.json` | Public mode only: the public half of the signing key. |
| `/_enig/signin` | [Web sign-in](#web-sign-in) only: the start page (`GET`) and its form (`POST`). |
| `/_enig/signout` | Web sign-in only: signs the browser out (`POST`). |

Behind a reverse proxy, forward `/_enig/handoff/` and `/_enig/atproto/`, and for web sign-in `/_enig/signin` and `/_enig/signout`.
