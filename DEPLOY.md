# Deploying COSMIC Space Blink AI

```
Browser ──► your-domain.com (GoDaddy DNS)
              │
              ▼
        Firebase Hosting ── serves the React frontend (frontend/dist)
              │  /api/**  (same website, no CORS)
              ▼
        Google Cloud Run ── "cosmic-blink" container: FastAPI backend (Dockerfile)
              │
              ├──► NASA/IPAC IRSA, SIMBAD, Gaia (data)
              └──► SPHEREx AI service (Cosmo), key kept in Secret Manager
```

Firebase Hosting forwards every `/api/...` request to the Cloud Run backend, so the browser sees one
website. The container also serves the frontend itself, so the Cloud Run URL works on its own too.

Commands below are for **Windows PowerShell**, run from the repository root (`COSMIC_SPACE_BlinkAI`).
Replace `YOUR_PROJECT_ID` with your Google Cloud project id.

## 0. Prerequisites (once)

1. A Google Cloud project with billing enabled (the NASA Space Apps Google Cloud offer covers the cost).
   Only the account owner enters payment details.
2. Install the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) and Node.js 20+.
3. Install the Firebase CLI: `npm install -g firebase-tools`

## 1. Set up Google Cloud (once)

```powershell
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
```

## 2. Store the AI key as a secret (once)

Put the key (ask the team lead) in a temporary file, create the secret, delete the file:

```powershell
Set-Content -NoNewline -Encoding ascii key.txt "PASTE_THE_KEY_HERE"
gcloud secrets create spherex-ai-key --replication-policy=automatic --data-file=key.txt
Remove-Item key.txt
```

Allow Cloud Run to read it:

```powershell
$num = gcloud projects describe YOUR_PROJECT_ID --format="value(projectNumber)"
gcloud secrets add-iam-policy-binding spherex-ai-key --member="serviceAccount:$num-compute@developer.gserviceaccount.com" --role="roles/secretmanager.secretAccessor"
```

## 3. Deploy the backend to Cloud Run

```powershell
gcloud run deploy cosmic-blink --source . --region us-central1 --allow-unauthenticated `
  --memory 4Gi --cpu 2 --no-cpu-throttling --min-instances 1 --max-instances 1 --timeout 300 `
  --set-env-vars SPHEREX_AI_URL=https://spherex-chatbot.onrender.com,CPU_WORKERS=2 `
  --set-secrets SPHEREX_AI_KEY=spherex-ai-key:latest
```

- Answer **Y** if it asks to create an Artifact Registry repository. The first build takes about 5–10 minutes.
- Why these settings: background jobs and the cache live in the instance's memory, so keep exactly
  **one** instance (`--min-instances 1 --max-instances 1`); downloads keep running between requests
  (`--no-cpu-throttling`); the cache lives in memory on Cloud Run (`--memory 4Gi`).
- At the end it prints a URL like `https://cosmic-blink-xxxx-uc.a.run.app`. Check
  `https://…run.app/api/health` shows `"status":"ok"`; the full app also works at that URL.

## 4. Deploy the frontend to Firebase Hosting

```powershell
firebase login
firebase projects:addfirebase YOUR_PROJECT_ID   # only the first time: adds Firebase to the same project
firebase use YOUR_PROJECT_ID
firebase deploy --only hosting
```

`firebase.json` builds the frontend automatically and forwards `/api/**` to the `cosmic-blink`
service in `us-central1` (keep the same name and region as in step 3). The site is live at
`https://YOUR_PROJECT_ID.web.app`.

## 5. Connect the GoDaddy domain

1. Firebase console → **Hosting** → **Add custom domain** → enter your domain (e.g. `cosmicblink.space`,
   and optionally `www.cosmicblink.space`).
2. Firebase shows the DNS records to add (a **TXT** record to verify, then **A** records).
3. GoDaddy → **My Products** → your domain → **DNS** → add exactly those records. Remove GoDaddy's
   default "Parked" A record and any domain forwarding.
4. Wait until Firebase shows **Connected** (often within an hour, up to 24 h). The SSL certificate
   (https) is created automatically.

## 6. Before judging

- Open the five test objects once (Mission Control → test object cards) so their images are cached;
  the first visit to a new field takes about 40 s while NASA images download.
- Open the site in a private/incognito window to check it works for someone who is not logged in.

## Updating

| What changed | Run |
|---|---|
| Backend (`backend/`) | step 3 again (same command) |
| Frontend (`frontend/`) | `firebase deploy --only hosting` |

## Notes and troubleshooting

- **Logs:** `gcloud run services logs read cosmic-blink --region us-central1 --limit 100`
- **Timeouts:** requests through Firebase Hosting time out after 60 s. All COSMIC API calls are short;
  long work (downloads, photometry) runs as background jobs that the page polls.
- **Cosmo:** through Firebase Hosting an answer may appear all at once instead of word by word.
  On the Cloud Run URL it streams normally.
- **Cost:** one always-on instance with 4 GB / 2 CPU uses credits continuously. After judging, stop it
  with `gcloud run services delete cosmic-blink --region us-central1`.
- **Local test of the container:** `docker build -t cosmic-blink .` then
  `docker run -p 8080:8080 -e SPHEREX_AI_KEY=... cosmic-blink` and open http://localhost:8080.
