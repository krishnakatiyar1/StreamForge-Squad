# CampusConnect

A Node.js campus portal with account signup, login

## Requirements

Node.js 22 or newer.

## Run

```bash
npm start
```

The server starts at `http://localhost:3000`. On its first start, it creates
`db/campusconnect.sqlite` with `users` and `sessions` tables.

- `/` serves the portal home page.
- `/health` returns a basic health response.
- `/api/auth/signup`, `/api/auth/login`, `/api/auth/me`, and `/api/auth/logout`
  provide session-based authentication.

Set `DATABASE_FILE` to use a different SQLite database location. Set
`NODE_ENV=production` when serving via HTTPS so session cookies include `Secure`.

For automatic restarts while developing:

```bash
npm run dev
```
