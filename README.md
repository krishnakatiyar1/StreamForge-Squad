# CampusConnect

A campus information portal built with a lightweight Node.js server (no framework) and MongoDB for user authentication. It serves static pages for courses, events, faculty, exams, fees, placements, and an AI assistant, with session-based login/signup.

## Features

- 🔐 User authentication (signup, login, logout) with hashed passwords and secure session cookies
- 🗄️ MongoDB for user and session storage
- 📄 Static pages: Home, Events, Faculty, Exams, Courses, Fees, Placements
- 🤖 AI Assistant page (protected — requires login)
- 🍪 HTTP-only session cookies with automatic expiry via MongoDB TTL index

## Tech Stack

- **Runtime:** Node.js (built-in `http` module — no Express)
- **Database:** MongoDB (via official `mongodb` driver)
- **Auth:** `crypto` module (scrypt password hashing, timing-safe comparison)
- **Frontend:** Static HTML/CSS

## Project Structure

```
streamforge-squad/
├── db/                     # (legacy, no longer used — see Migration Notes)
├── public/                 # Static frontend pages
│   ├── assets/
│   ├── index.html
│   ├── login.html
│   ├── signup.html
│   ├── ai-assistant.html
│   ├── courses.html
│   ├── events.html
│   ├── exams.html
│   ├── faculty.html
│   ├── fees.html
│   ├── placements.html
│   └── style.css
├── src/
│   └── index.js            # Server entry point
├── .env                    # Environment variables (not committed)
├── .gitignore
├── package.json
└── README.md
```

## Getting Started

### Prerequisites

- Node.js (v22 or later recommended — uses native `.env` loading)
- A MongoDB database (local or [MongoDB Atlas](https://www.mongodb.com/atlas))

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/repo-name.git
   cd repo-name
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the project root:
   ```
   MONGO_URI=mongodb+srv://<username>:<password>@<cluster-url>/campusconnect?retryWrites=true&w=majority
   PORT=3000
   ```

4. Run the server:
   ```bash
   node src/index.js
   ```

5. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Environment Variables

| Variable    | Description                                  | Required |
|-------------|-----------------------------------------------|----------|
| `MONGO_URI` | MongoDB connection string                     | Yes      |
| `PORT`      | Port the server listens on (default: `3000`)  | No       |
| `NODE_ENV`  | Set to `production` to enable secure cookies  | No       |

## API Routes

| Method | Route                | Description                          | Auth Required |
|--------|-----------------------|---------------------------------------|----------------|
| POST   | `/api/auth/signup`   | Create a new user account            | No             |
| POST   | `/api/auth/login`    | Log in and start a session           | No             |
| GET    | `/api/auth/me`       | Get the currently logged-in user     | Yes            |
| POST   | `/api/auth/logout`   | End the current session              | No             |

## Pages

| Route            | Description                          |
|-------------------|---------------------------------------|
| `/`               | Home page                            |
| `/login`          | Login page                           |
| `/signup`         | Signup page                          |
| `/events`         | Campus events                        |
| `/faculty`        | Faculty directory                    |
| `/exams`          | Exam schedules                       |
| `/courses`        | Course listings                      |
| `/fees`           | Fee information                      |
| `/placements`     | Placement information                |
| `/ai-assistant`   | AI assistant (requires login)        |

## Migration Notes

This project originally used SQLite for all data (`db/campusconnect.sqlite`), including user accounts. Authentication has since been fully migrated to MongoDB — the `db/` folder and its SQLite files are no longer used and can be safely removed.

## Security Notes

- Passwords are hashed using `scrypt` with a random salt and compared using timing-safe equality checks.
- Sessions use HTTP-only, `SameSite=Lax` cookies and expire automatically after 24 hours (enforced by a MongoDB TTL index).
- Never commit your `.env` file — it contains your live database credentials. It is already excluded via `.gitignore`.


