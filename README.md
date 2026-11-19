# The Team Test

A fan recreation of the 2010 Swedish Armed Forces "Team Test" (not affiliated).
Four players, one shared screen, each keeping the next player alive.

Try it [here](https://team-test-auom.onrender.com/).
## What's here

| File                | What it is                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `public/index.html` | The whole game: one page, no build step                                                   |
| `server.js`         | Serves the page and relays live player state for online teams. No game logic, no database |
| `package.json`      | Lets you run it with `npm start`. There are no dependencies to install                    |
| `Dockerfile`        | Optional, for container hosting                                                           |

## Run it on your computer

Needs [Node.js](https://nodejs.org) 18 or newer.

```
node server.js
```

Open http://localhost:8080. To play with people on the same network, they open `http://<your computer's IP>:8080`.
Change the port with `PORT=3000 node server.js`.

## Put it online

Any host that runs Node.js and allows WebSocket connections works. The server is a single process with no database, so the smallest plan is enough.

- **A virtual server (VPS):** copy the folder, run `node server.js` under a process manager (systemd or pm2), and put a web server with HTTPS in front. With Caddy the whole config is:
  ```
  teamtest.example.com {
      reverse_proxy localhost:8080
  }
  ```
  With nginx, pass the WebSocket upgrade for `/ws`:
  ```
  location /ws {
      proxy_pass http://localhost:8080;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
  }
  ```
- **Container hosts** (Fly.io, Render, Railway and similar): build the included `Dockerfile`, expose port 8080, and make sure WebSockets are enabled. Run a single instance, because players can only meet on the same server process.

The page connects back to whatever address served it (`wss://` on HTTPS), so there is nothing to configure.
Health check: `GET /healthz` returns `ok`.

## How online play works

- **Connect to team** queues you with whoever else is waiting. Four players start a 25-second countdown; if fewer have waited 30 seconds, bots fill the empty seats.
- **Create own team** gives a 5-character code that friends enter under "Have a team code?".
- Each browser runs its own corner and broadcasts its state about ten times a second; the server only forwards it to the other three. A player who disconnects is replaced by a bot.

## Sound and voice

All effects are synthesized in the page. The announcer's lines are short MP3 clips embedded in the page, recorded offline with the open Kokoro speech model (Apache-2.0, voice "af_heart"); if a browser can't play them, it falls back to its own built-in speech. Players can turn the voice or all sound off in the footer.

## Limits to know

- Players' browsers report their own results.
- No accounts and no saved leaderboard; personal bests live in each player's browser.
- One process holds everyone. A few hundred players at once is comfortable; beyond that the lobby list gets heavy.
- If the server can't be reached, the page still offers practice with three bots.

This is an unofficial fan reproduction and unaffiliated with the Swedish Armed Forces or makers of the original game.
