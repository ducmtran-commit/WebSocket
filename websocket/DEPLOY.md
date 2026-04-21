# Deploy Guide (GitHub Pages + Render)

This project uses:
- **Frontend**: GitHub Pages (static files)
- **Backend**: Render (Node.js + Socket.IO server)

## 1) Deploy backend to Render

1. Push this repository to GitHub.
2. In Render, create a **New Web Service** from the repo.
3. Set:
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Add environment variable:
   - `CLIENT_ORIGIN=https://ducmtran-commit.github.io`
5. Deploy and copy your Render URL (example: `https://my-draw-app.onrender.com`).

## 2) Keep frontend on GitHub Pages

Your frontend URL:
- `https://ducmtran-commit.github.io/WebSocket/websocket/`

The app will prompt once for your backend URL when opened on GitHub Pages.
Paste your Render URL and it will be saved in browser localStorage.

### Important GitHub Pages settings (to avoid 404)

In your repository settings:
1. Open **Settings -> Pages**
2. Under **Build and deployment**, choose:
   - **Source**: Deploy from a branch
   - **Branch**: `main`
   - **Folder**: `/docs`
3. Save and wait 1-3 minutes for publish.

## 3) Update backend URL later

If you redeploy and get a new URL:
1. Open browser DevTools on the frontend page
2. Run:
   - `localStorage.removeItem("socketServerUrl")`
3. Refresh the page and enter the new backend URL.
