# Collaborative Canvas

Collaborative Canvas is a real-time shared drawing board built for a class project. Multiple users can connect to the same room and draw together on one canvas. Every brush movement is sent through WebSockets, so marks appear instantly for everyone.

## Concept Paragraph (for assignment)

Collaborative Canvas explores drawing as a social activity instead of an individual one. A stroke is not only a personal gesture but also a shared event witnessed by others in real time. By turning a canvas into a live public surface, the project frames mark-making as collaboration, negotiation, and collective authorship.

## Tech Stack

- Node.js
- Express
- WebSocket with `ws`
- Plain HTML/CSS/JavaScript

## Project Structure

```text
.
├─ public/
│  ├─ index.html
│  ├─ style.css
│  └─ client.js
├─ server.js
├─ package.json
├─ .gitignore
├─ render.yaml
└─ README.md
```

## Setup

1. Install Node.js (18+ recommended).
2. Open terminal in this project folder.
3. Run:
   - `npm install`

## Run Locally

1. Start the app:
   - `npm start`
2. Open:
   - `http://localhost:3000`
3. Open a second tab (or another browser) to test collaboration.

## Deployment on Render

### Option A: Using `render.yaml` (recommended)

1. Push this repository to GitHub.
2. In Render, click **New +** -> **Blueprint**.
3. Select your GitHub repository.
4. Render reads `render.yaml` automatically.
5. Deploy and open your live URL.

### Option B: Manual Web Service setup

1. In Render, click **New +** -> **Web Service**.
2. Connect your GitHub repository.
3. Use:
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Deploy.

## Add Final Links Before Submission

- GitHub Repository URL: `PASTE_YOUR_GITHUB_REPO_URL_HERE`
- Live Deployment URL: `PASTE_YOUR_RENDER_LIVE_URL_HERE`

## Assignment Checklist Mapping

- Uses WebSockets: yes (`ws`)
- Includes Node.js server: yes (`server.js`)
- Multiple clients share interaction live: yes (room broadcast)
- Deployable as live site: yes (Render instructions/config included)
- Concept paragraph included: yes (see above)
- Ready for repo link + live link submission: yes (placeholders included)

## Sample GitHub Repo Description

Collaborative Canvas is a beginner-friendly Node.js + WebSocket class project where multiple users draw together in real time on a shared online canvas.

## Sample Submission Text (for class)

I built Collaborative Canvas, a real-time multi-user drawing board using Node.js, Express, and the `ws` WebSocket library. The server broadcasts drawing events (`draw-start`, `draw-move`, `draw-end`, and `clear-canvas`) so all connected clients see the same interaction instantly. The app includes color and brush controls, user count, room support, and reconnect-safe client behavior. It is deployed as a live web app on Render.

## Critique Slide Text

**Project Title:** Collaborative Canvas  
**Concept:** A shared canvas where drawing becomes a social interaction in real time.  
**Tech Stack:** Node.js, Express, WebSocket (`ws`), HTML/CSS/JavaScript.  
**Interaction Summary:** Users join a room, draw with color/brush controls, and see all marks instantly across clients.  
**GitHub Link:** `PASTE_GITHUB_LINK_HERE`  
**Live Site Link:** `PASTE_LIVE_SITE_LINK_HERE`
