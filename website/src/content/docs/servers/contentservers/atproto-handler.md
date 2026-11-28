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
* **Members can type their username instead.** A member whose user is linked to an AT account may enter their username here (any case) in place of the whole handle. The board looks up the account linked to that user, and accepts the approval only from it. The request goes to that account's host without naming the account, so typing someone's username doesn't show which Bluesky account is theirs. Input with a dot is tried as a handle first, then as a username; input without one, the other way round.
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
| `atProto.publishing.listing` | Object. The board's listing: `description`, `tags`, `rules`, `howToJoin`, `hours`, `deriveEndpoints`, `endpoints`, `sysopDid`, `rating`. | (empty) |
| `atProto.publishing.triggers.moved` | Object. `enabled` and `message`: post the new addresses when the listing's addresses change. | off |
| `atProto.publishing.assets` | Array. The board's [art](#its-art), published for hubs to show: each an art name or path, or an object with `art`, `name`, `description`, `licence`, `rating`, `themes` and `credit`. A [3D model](#3d-models) has `model` and `image` in place of `art`. | `[]` |
| `atProto.publishing.models.maxBytes` | Number. The largest [3D model](#3d-models) file (and preview picture) published, in bytes. | `8388608` (8 MB) |
| `atProto.publishing.emblem.art` | String. The board's [emblem](#its-emblem), a small logo for its hub's map: an ANSI art name or a path to an `.ans` file. Naming one offers it. | (none) |
| `atProto.publishing.splash.art` | Array. The [splash screen](#its-splash-screen) offered to the board's hub: ANSI art names, tried in order in the pre-login theme and the general art directory, or paths to `.ans` files. | `[ "CONNECT", "MATRIX" ]` |
| `atProto.publishing.minPostIntervalSeconds` | Number. At most one announcement this often. | `60` |
| `atProto.publishing.postLangs` | Array. Languages announcements are written in. | `["en"]` |
| `atProto.publishing.nsidPrefix` | String. Prefix of the published record names. | `nexus.cyberspace.dev` |
| `atProto.publishing.permissionSet` | String. A permission set to ask the board account for in place of each record type by name; see *Record names* below. Changing it means connecting the account again. | (none) |
| `atProto.hub.url`, `atProto.hub.name`, `atProto.hub.token` | Strings. The hub the board runs behind, its name there and its token, for [presence on the hub](#presence-on-the-hub). | (empty) |
| `atProto.hub.presence.enabled` | Boolean. Tell the hub which members are on, for those who chose to be shown. | `false` |
| `atProto.hub.presence.includeLocalUsers` | Boolean. Also report members with no linked AT account, by user name. | `false` |
| `atProto.hub.presence.hubIdleMinutes` | Number. Idle limit for a member busy in the hub's common space; see [Busy on the Hub](#busy-on-the-hub). `0` turns it off. | `30` |
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

The login screen uses the `ATPROTOLOGIN` art with two views: `ET1`, where the caller types their handle or username, and `MT2`, for instructions, the link to open and progress.

**Making the link easy to open.** With `hyperlinks: true` on `MT2` (as in the template), the link is clickable in terminals that support OSC 8 links, enig-term among them, where tapping it on a phone asks before opening it. With `qrCode: true` in the menu's `config` (as in the template), the link is also drawn as a QR code at the bottom right of the screen, for approving on a phone from a computer's terminal. It is drawn only when the screen has room for it below the link (an 80 by 25 screen does), and cleared when the login ends.

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

then restart, and connect the account from the **board account** menu (`boardAtProtoAccount` in the main menu template, behind a commented out `BA` command): enter the board account's handle and approve it in a browser, as for Bluesky login. As on the Bluesky login screen, the menu's `config.qrCode` (on in the template) also draws the approval link as a QR code, for approving on a phone; the fields it covers meanwhile are drawn again once it is gone. The board asks only for what it needs: to write its listing and status records and its art (asset records), to create posts, and to upload files, which do nothing until one of those records names them. Permissions name record types exactly, so when the board asks for more (as when it gained its art, or once the record names are final), the board account menu and `./oputil.js atproto board` say the account must be connected again; connecting again keeps everything else. Members are still asked for proof of identity alone. The board keeps this write session apart from members' logins, so the account may also be someone's login here.

The menu is for sysops: its `config.acs` is `GM[sysops]` in the template. Change it to `ID1` to let only the root user (#1) in. It shows the connected account, and can post an announcement, publish the listing now, or disconnect the account (which revokes the board's access; its records stay until removed).

**The listing** is written when the account is connected, at startup, daily, and soon after `config.hjson` changes, and only when it differs from what was last written. Its ways to connect are taken from the enabled servers (the web sign-in page, or enig-term; SSH; telnet) when their addresses are public, plus any in `listing.endpoints`; set `listing.deriveEndpoints: false` to list only those. Its admission policy is `atProto.admission.policy`. Private and loopback addresses are never listed.

**Its rating** (`listing.rating`) is the most mature content anything on the board may have: `general` (all ages, the default), `mature` or `adult`. Hubs list only the ratings they allow, so an adult board appears only on hubs that admit adult boards. It is also published as AT self-labels (`graphic-media` and `nudity` for `mature`; `sexual` and `porn` for `adult`), so other AT apps and moderation services see it. A rating that isn't one of the three stops the listing from being published, rather than listing the board as all ages.

**A "we've moved" post.** With `triggers.moved.enabled`, when the listing's addresses change (the board has moved to another hub, or to its own address), the board posts the new ones from its account, which its followers see wherever it went. The message is `triggers.moved.message`, with `{boardName}` and `{addresses}` filled in; addresses that don't fit in a post are left off. Nothing is posted for the first listing, for other changes, or when no address is left to list. It counts as an announcement, so it waits for `minPostIntervalSeconds`; if it can't be posted, the listing is still published.

### Its Splash Screen

A hub can show the board's splash screen, the ANSI art callers first see, on its directory and on the board's own page there, credited to its artist. The board offers it only with the sysop's say-so, and the say-so is to one file: the art as it was when they agreed.

- **Connecting the board account** the first time turns it on for the art the board would offer then, and the screen says so: "Its login screen will be shown on the hub, credited to its artist; choose "splash" to stop that." The answer is kept, with when it was given and which file it was; connecting again later keeps it. A board account connected before this existed isn't assumed to agree: it stays off until the sysop turns it on.
- **Not for ENiGMA½'s stock art.** If the login screen is art that comes with ENiGMA½ (its stock theme, by the art's hash, listed in `core/atproto/stock_art.json`), connecting leaves it off and says why: that art belongs to its artists, not to the sysop. Name art of your own in `atProto.publishing.splash.art`, or turn it on only if its artists allow it.
- **Asked again when the art changes.** If the login screen becomes another file (a new theme, an edited screen), the board stops offering it, and tells the sysop once, in the log and in a private message they see at their next login. The board account menu and `./oputil.js atproto board` say so too. Choosing "splash" (or `./oputil.js atproto splash on`) agrees to the new art.
- **"splash"** on the board account menu turns it off, or on again for the art as it is now. So does `./oputil.js atproto splash off` (or `on`).

A board that agreed before consent was to a file keeps showing the art it offers now, unless that is ENiGMA½'s stock art, which then stops, with the same message.

**Which art.** By default the board's `CONNECT` art, if its pre-login theme (`theme.preLogin`) or the general art directory has one, otherwise its login matrix (`MATRIX`), as a menu would find them (`NAME.ANS`, or the first random variant, `NAME1.ANS`). `atProto.publishing.splash.art` names other art, in order, or `.ans` files by path. Only ANSI art up to 64 KB is offered. The fork ships a `CONNECT` screen of its own in the general art directory (`art/general/CONNECT.ANS`, a synthwave sunset, CC BY 4.0), so a board on the stock theme, which has none, offers that rather than the stock login matrix; a theme's own `CONNECT` art comes first.

**How it reaches the hub.** The listing names the file by its SHA-256 and size (`splash`); the board serves it as it is at `/assets/<sha256>`, and only that file. The hub cleans it (nothing but characters and colors survives), blanks ENiGMA½'s menu codes so none of the board's live details show, draws it, and takes the credit from its SAUCE record. When the art changes, the listing names no splash until the sysop agrees to the new file (above).

**The art must be the sysop's to share.** Agreeing covers the board; it can't give away an artist's rights. Art made for the board, or under a licence that allows it, is fine. A hub may also refuse art it hasn't cleared, such as ENiGMA½'s stock themes.

### Its Emblem

The emblem is a small logo that stands for the board on its hub's map, drawn in the board's place there. There is none until the sysop names one in `atProto.publishing.emblem.art`, as an art name (looked for as the splash is) or a path to an `.ans` file; naming it is the sysop's say-so to offer it. Keep it small: a few lines of a dozen or so characters suit a map. The listing names it as it names the splash (`emblem`), the board serves it at `/assets/<sha256>`, and the hub cleans, draws and credits it the same way. `./oputil.js atproto board` shows which file it is.

### Its Art

The board can publish ANSI art from its own account for hubs to show, in their galleries and chat, credited to it. List the pieces in `atProto.publishing.assets`, each an art name (looked for as the splash is) or a path to an `.ans` file, or an object:

```hjson
assets: [
    "WELCOME"
    {
        art: "/enigma-bbs/config/art/LOGO.ANS"
        name: "Our logo"
        description: "The board's logo, in pink and white"
        licence: { id: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/" }
        credit: { author: "Ana", group: "ACiD" }
    }
]
```

Each piece is uploaded to the account's host and published as an asset record (`asset.item`), keyed by its file's SHA-256, with a catalogue of them (`asset.catalogue`). Unchanged art isn't uploaded again, and pieces taken off the list are deleted, down to the last: with the list emptied, everything published from it is taken down. Credit comes from each file's SAUCE record, which a hub reads when it draws the art; `credit` adds to it. A piece without a `licence` says it is shown with the board's consent, and to ask before any other use. It is published at startup, when the config changes, and when the board account is connected, or at once with `./oputil.js atproto assets`.

**Everything published is public, and must be the board's to share.** Art made for the board, or under a licence that allows it, is fine; give its licence. ENiGMA½'s own theme art belongs to its artists.

#### 3D Models

A piece can be a 3D model instead of ANSI art. Its entry names two files in place of `art`: `model`, a binary glTF file (`.glb`), and `image`, a PNG picture of it, which a hub shows wherever it can't show the model itself (in its gallery, and to visitors without scripts). Both are needed. The other fields are those art has:

```hjson
assets: [
    "WELCOME"
    {
        model: "/enigma-bbs/config/models/clock.glb"
        image: "/enigma-bbs/config/models/clock.png"
        name: "Brass Clock"
        description: "A brass mantel clock, its pendulum swinging"
        licence: { id: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/" }
        credit: { author: "Ana" }
    }
]
```

Both are paths to files, absolute or relative to the board's directory (where `main.js` is), as a path to an `.ans` file is; neither is looked for by name in the theme or art directories. An entry is art or a model, never both: list them as two.

Both files are uploaded to the account's host, and one record is published, keyed by the model file's SHA-256, naming the model and then its picture. A model that hasn't changed isn't uploaded again; with a new picture, only the picture is. Taking the entry off the list deletes its record, as for art. A name not given is the model's file name.

Before uploading, the board checks that the model is a binary glTF file, version 2, whose header gives the file's own length, that the picture is a PNG, and that neither is over `atProto.publishing.models.maxBytes` (8 MB unless set). An entry that fails, or that can't be published as written (no `image`, say), is left out, the rest is published, and the log and `./oputil.js atproto assets` say why, naming the limit when that was it; `oputil` then ends with an error status.

A model already published isn't taken down because its entry stops passing or its files can't be found, as when a file is being copied over just as the board publishes. Records are kept by the file's hash, so the board can't tell which one belonged to the failing entry: while any listed model is left out, every model published earlier stays as it is, in the catalogue too, and `oputil` says how many were left. Mend the entry, or take it off the list, and the next publish deletes what is no longer listed. Art taken off the list is deleted either way.

If the account's host refuses a file (it has an upload limit of its own), publishing stops there and what the host said is passed on, with the file's name. Nothing listed after that file is published, and nothing is deleted, until the file is fixed or its entry taken off the list. A hub checks a model much more closely before showing it, and has limits of its own: a model published here is one the hub may still decline.

#### Programs and Live Objects

A hub that runs live objects shows things that change: the weather in a town, as a badge on the hub's map, say. Each is a small **program** (WebAssembly) and an **object** that gives it its input. The hub runs the program, within limits its admin sets, and only if its admin has checked that program by its hash; it reaches only the sites both the program and the hub allow.

A program is published as art is, as an entry in `atProto.publishing.assets` with `program` (a path to its `.wasm` module), `source` (a path to its source, shown to anyone on the hub, so people can see what it does), a `licence` (required: code needs one; under an open-source licence, anyone may copy and remix it) and a `manifest`:

```hjson
assets: [
    {
        program: "/enigma-bbs/config/programs/weather.wasm"
        source: "/enigma-bbs/config/programs/weather.ts"
        name: "Weather (Open-Meteo)"
        description: "The current weather for a place"
        licence: { id: "BSD-2-Clause", url: "https://opensource.org/license/bsd-2-clause" }
        manifest: {
            fetch: [ "api.open-meteo.com", "geocoding-api.open-meteo.com" ]
            values: weather
            credit: [
                { text: "Weather data by Open-Meteo.com", url: "https://open-meteo.com/" }
                { text: "Place names from GeoNames", url: "https://www.geonames.org/" }
            ]
        }
    }
]
```

`fetch` is the sites the program reads, by host name; `values` is the shared type of what it sets (`weather`); `credit` is what the data it shows must credit, shown by the hub wherever it is. The board checks that the module is WebAssembly and the source is text, each within its limit (1 MB and 256 KB); the hub checks the rest. The framework's own weather program is in the hub's repository, under `programs/weather`.

The objects are listed in `atProto.publishing.objects`, each published as a record of its own, keyed by its `name`:

```hjson
objects: [
    {
        name: berlin
        title: "Weather in Berlin"
        program: "/enigma-bbs/config/programs/weather.wasm"
        input: { name: "Berlin" }
        interval: 600
    }
]
```

`program` is the path of the module (published above), or `{ sha256: "...", did: "did:plc:..." }` for a program another account publishes. `input` is given to the program: for the weather, a place by `name`, or by `latitude` and `longitude` with a `label`. `interval` is how often it updates, in seconds; a hub may make it longer. An object taken off the list is deleted. **Everything here is public, the input too:** a place name or coordinates can say where someone lives, so name a town rather than an address.

Objects need the board account to allow them. An account connected before they were asked for doesn't: art goes on being published, and the board account menu and `./oputil.js atproto board` say what is missing; connect the account again, and its objects are published once it is connected.

**From the command line**, using the stored session, whether or not the board is running:

```shell
./oputil.js atproto board                       # which account, and when it last published
./oputil.js atproto publish                     # the listing, if it changed (--force: anyway)
./oputil.js atproto status maintenance --message "New hardware" --until 2026-12-01T20:00Z
./oputil.js atproto post "Door games night this Friday!"
./oputil.js atproto splash off                  # stop the hub showing the splash screen (on: again)
./oputil.js atproto assets                      # publish the listed art now
./oputil.js atproto objects                     # publish the listed live objects now
```

Posts are plain text, up to 300 characters, with web links made clickable, and at most one per `minPostIntervalSeconds`. They are public and effectively permanent: Bluesky honors deletes, but copies may persist.

**Record names.** The listing and status are custom AT records, which the Bluesky app ignores. While their layout is a draft they are named under `nexus.cyberspace.dev` (`nexus.cyberspace.dev.leaf.listing`, `.leaf.status`); `atProto.publishing.nsidPrefix` changes the prefix once the layout is final. Published names are permanent.

**Permission sets (trial).** By default the board account is asked for each record type by name, so a new type means connecting the account again. With `atProto.publishing.permissionSet` set to a permission set, such as `nexus.cyberspace.dev.authBoard`, it's asked for that set instead (with posts and files beside it, which a set can't carry), and record types added to the set later are allowed within a day, without connecting again. Whether account hosts honour sets is being tried; leave it unset unless you're part of the trial.

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

**Through a hub,** `./oputil.js config hub --agent coolbbs-agent.toml` does all of this from the agent config the hub gave you, along with [presence on the hub](#presence-on-the-hub) and the menu entries ([oputil](../../admin/oputil.md#configuration)). By hand: `overrideUrlPrefix` is the board's address on the hub (such as `https://coolbbs.hub.example`). The hub's tunnel agent runs next to the board and connects to it on `127.0.0.1`, which the default `trustedProxies` covers, and its generated config sets `X-Forwarded-Proto` for the board. The hub serves enig-term itself.

### Presence on the Hub
A hub can have a common space where people from all its boards see who is around. With `atProto.hub.presence.enabled`, the board tells its hub which of its members are on, **only for members who chose it**:

```hjson
atProto: {
    hub: {
        //  the hub's own address
        url: "https://hub.example.net"
        //  both are in the agent config the hub gave you:
        //  "subdomain", and "metadatas.token"
        name: coolbbs
        token: "hub_..."
        presence: {
            enabled: true
        }
    }
}
```

* **Each member chooses.** Being shown is off for every member until they turn it on, from the hub presence menu (`hubPresenceConfig` in the main menu template, behind a commented out `HP` command). A member set invisible on the board counts as not on.
* **The sysop can keep anyone off the hub,** whatever they choose: `./oputil.js user hub USERNAME withhold` (and `allow` to undo). `./oputil.js user info USERNAME` shows both settings.
* **What is sent:** for each member who chose it, their linked AT identity (DID), their user name here, when they joined, and whether they are on now. Nothing else. The hub uses this to show them, and to know they are a member of a board on it, which by default is what lets them into its common space. It is sent to the hub only, never published, and each report is the whole list, so a member who turns it off is gone from the next one.
* **The hub decides how to show them.** A member is shown by their user name here, as "alice via coolbbs", until they sign in at the hub and confirm this board; then they appear as their own Bluesky account. With `includeLocalUsers`, members with no linked AT account are reported by user name, and the hub shows them as `alice@coolbbs` if its admin accepts them from this board.
* **When:** after each login and logoff, a member's change of setting, and every minute, so the hub knows the board is still up. The token is sent only over `https://`, or `http://` to `127.0.0.1` for a hub on the same machine.

### Busy on the Hub
A member doesn't need to be logged in to the board to take part in the hub's common space: the board's report is what vouches for them. But someone who has the board open and turns to the hub's page to chat looks idle to the board. So the hub, in its answer to each report, says which of the board's members are in its space now, and when they last did something there. While it does, the board counts that as activity, and gives them `atProto.hub.presence.hubIdleMinutes` (30 by default) from their last action on either side before logging them off. A window left open on the hub still frees its node in the end.

The hub says this only about members the board itself reported, and only while their presence on the hub is on: the board learns that they are in the hub's space, and when they last did something there, nothing more.

### The Hub's Space as a Door
With presence on the hub set up, members can open the hub's common space from inside the board: the `hubSpace` menu in the main menu template, behind a commented out `HS` command. It needs nothing more in `config.hjson`.

* **Who is around** on the hub's boards and in its chat room, one line a place, kept up to date while the member watches.
* **Live objects** a board has on the hub, such as the weather in a town, on lines beneath it, in words, with the credit their data needs.
* **The hub's chat room,** shared with people on other boards and on the hub's web page. Only members who confirmed this board at the hub can talk: the hub never lets a board speak as someone's Bluesky account on the board's word alone. Others can watch who is around.
* **Who can open it:** members the board reports to the hub, so being shown has to be on (Hub Presence), and the hub has to let them into its space. A member who can't is told why.
* **How:** the board connects to the hub for the member, with its token, and names the member as presence reports do. Names and messages from elsewhere are shown as plain text: color and control codes in them are not used.
* **Commands**, typed where members talk: `/mute name` hides someone from them (here and on the hub's pages; the other person isn't told), `/unmute name` and `/mutes` undo and list that, and `/report name what happened` sends a report to the hub's admin with what was said in the room in the last few minutes. `/help` lists them. Muting needs a member who confirmed this board at the hub; anyone in the space can report.
* **Blocks** are the hub admin's: a member the hub blocked is told so, by whom, and why, when they open it or while they are in it.
* **Idle logoff** is off while a member is in it, as in MRC chat, unless the menu's `idleLogoutSeconds` is set (60 or more).

## Routes
| Route | Purpose |
|-------|---------|
| `/_enig/handoff/<code>` | The short link shown in the terminal. Sends the browser on to the caller's account host. |
| `/_enig/atproto/callback` | Where the account host sends the browser after the caller approves or denies. |
| `/_enig/atproto/client-metadata.json` | Public mode only: identifies the BBS to account hosts. |
| `/_enig/atproto/jwks.json` | Public mode only: the public half of the signing key. |
| `/_enig/signin` | [Web sign-in](#web-sign-in) only: the start page (`GET`) and its form (`POST`). |
| `/_enig/signout` | Web sign-in only: signs the browser out (`POST`). |
| `/assets/<sha256>` | With publishing on: the [splash screen](#its-splash-screen) the sysop agreed to and the [emblem](#its-emblem) the listing names, and nothing else. |

Behind a reverse proxy, forward `/_enig/handoff/` and `/_enig/atproto/`, for web sign-in `/_enig/signin` and `/_enig/signout`, and for the splash screen `/assets/`.
