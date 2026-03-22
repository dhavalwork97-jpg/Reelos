# REEL OS — Deploy on Render (Free)

Your app will be live at a public URL like `https://reelos.onrender.com`
No credit card. No local setup. Anyone can use it from any device.

---

## Step 1 — Get your free Pexels API key
1. Go to https://www.pexels.com/api/
2. Click **Get Started** → create a free account
3. Copy your API key (looks like: `563492ad6f91700001000001abc...`)

---

## Step 2 — Push files to GitHub

You need these 4 files in a GitHub repo:
```
reelos/
├── server.js
├── index.html
├── package.json
└── .gitignore
```

**If you've never used GitHub:**
1. Go to https://github.com/new
2. Name it `reelos`, set to **Public**, click **Create repository**
3. Click **uploading an existing file**
4. Drag and drop all 4 files → click **Commit changes**

**If you use Git in terminal:**
```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/YOURUSERNAME/reelos.git
git push -u origin main
```

---

## Step 3 — Create a Render Web Service

1. Go to https://render.com → sign up free (use GitHub login)
2. Click **New +** → **Web Service**
3. Click **Connect** next to your `reelos` repo
4. Fill in the settings:

| Field | Value |
|---|---|
| **Name** | reelos (or anything) |
| **Region** | Closest to you |
| **Branch** | main |
| **Runtime** | Node |
| **Build Command** | *(leave blank)* |
| **Start Command** | `node server.js` |
| **Instance Type** | **Free** |

---

## Step 4 — Add your Pexels API key

Still on the Render setup page, scroll down to **Environment Variables**:

| Key | Value |
|---|---|
| `PEXELS_KEY` | `your_pexels_api_key_here` |

Click **Add** to save it.

---

## Step 5 — Deploy

Click **Create Web Service**.

Render will:
- Pull your code from GitHub
- Install Node.js automatically
- Start `node server.js`
- Give you a live URL like `https://reelos.onrender.com`

First deploy takes ~2 minutes. You'll see the logs in real time.

---

## Step 6 — Open your app

Click the URL at the top of your Render dashboard.
The **green dot** in the app header confirms the server and Pexels key are working.

---

## Notes

**Free tier sleep:** Render's free tier spins down after 15 min of inactivity.
First request after sleep takes ~30 seconds to wake up. Paid tier ($7/mo) stays always on.

**Update the app:** Just push new changes to GitHub — Render auto-redeploys.

**Add your Pexels key later:** Render dashboard → your service → Environment → edit `PEXELS_KEY`.

---

## File summary

| File | Purpose |
|---|---|
| `server.js` | Node.js server — calls Pexels API, serves the frontend |
| `index.html` | The full app UI |
| `package.json` | Tells Render it's a Node app and how to start it |
| `.gitignore` | Keeps node_modules out of GitHub |
