# JIYA Back Office — Complete Deployment Guide

## What You Need (All Free)
- GitHub account → github.com
- Vercel account → vercel.com
- Supabase account → supabase.com
- Your purchased domain

---

## STEP 1 — Set Up Supabase Database (15 mins)

1. Go to **supabase.com** → Sign Up (use Google login for speed)
2. Click **"New Project"**
   - Organization: create one with your name
   - Project name: `jiya-backoffice`
   - Database password: create a STRONG password (save it somewhere!)
   - Region: **Southeast Asia (Singapore)** ← closest to India
   - Click **Create Project** (takes 2-3 minutes)

3. Once project is ready, go to **SQL Editor** (left sidebar)
4. Click **"New Query"**
5. Open the file **SUPABASE_SETUP.sql** from this folder
6. Copy ALL the contents → Paste into SQL Editor → Click **Run**
7. You should see "Success" for each table created

8. Now go to **Settings → API** (left sidebar)
9. Copy these two values:
   - **Project URL** → looks like: `https://abcdefgh.supabase.co`
   - **anon public** key → long string starting with `eyJ...`

---

## STEP 2 — Add Your Keys to the App (5 mins)

1. Open the file **src/App.jsx** in a text editor (Notepad works)
2. Find these two lines near the top (around line 250):
   ```
   const SUPABASE_URL = "YOUR_SUPABASE_URL";
   const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";
   ```
3. Replace with your actual values:
   ```
   const SUPABASE_URL = "https://abcdefgh.supabase.co";
   const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsIn...";
   ```
4. Save the file

---

## STEP 3 — Upload to GitHub (10 mins)

1. Go to **github.com** → Sign Up / Sign In
2. Click the **+** icon → **New repository**
   - Repository name: `jiya-backoffice`
   - Set to **Private** ← IMPORTANT for security
   - Do NOT initialize with README
   - Click **Create repository**

3. GitHub will show you commands. Follow the "upload files" option:
   - Click **"uploading an existing file"** link on that page
   - Drag and drop ALL files from this folder into GitHub
   - Important: Upload the FOLDER STRUCTURE correctly:
     ```
     index.html
     package.json
     vite.config.js
     vercel.json
     .gitignore
     src/
       App.jsx
       main.jsx
       index.css
     public/
       favicon.svg
     ```
   - Click **Commit changes**

---

## STEP 4 — Deploy on Vercel (10 mins)

1. Go to **vercel.com** → Sign Up with GitHub
2. Click **"Add New Project"**
3. Find your `jiya-backoffice` repository → Click **Import**
4. Settings (Vercel auto-detects most):
   - Framework: **Vite**
   - Root Directory: `./` (leave as is)
   - Build Command: `npm run build`
   - Output Directory: `dist`
5. Click **Deploy**
6. Wait 2-3 minutes → Your site is live at `https://jiya-backoffice.vercel.app`

---

## STEP 5 — Connect Your Domain (20 mins)

1. In Vercel → Your Project → **Settings → Domains**
2. Type your domain name → Click **Add**
3. Vercel shows you DNS records to add

4. Go to your domain provider (GoDaddy / BigRock / Namecheap):
   - Find **DNS Management** / **DNS Records**
   - Add a **CNAME record**:
     - Name/Host: `www`
     - Value/Points to: `cname.vercel-dns.com`
   - Add an **A record** (for root domain):
     - Name/Host: `@`
     - Value: `76.76.21.21`

5. Wait 10-30 minutes for DNS to update
6. Your site is now live at your domain! ✅

---

## STEP 6 — Test Everything

1. Open your domain in browser
2. Login as admin: **JIYA / Jiya@3044**
3. Add a test client
4. Check the sidebar shows "✓ Saved to database"
5. Refresh the page → client should still be there (data is in Supabase!)
6. Login as the test client to verify client login works

---

## Your Data is Now Stored Here

| What | Where | Safety |
|------|-------|--------|
| All clients | Supabase PostgreSQL database | Automatically backed up daily by Supabase |
| All trades | Supabase | Never lost even if Vercel goes down |
| Ledger, P&L | Supabase | 99.9% uptime guarantee |
| Your code | GitHub (private repo) | Version controlled |
| Your website | Vercel CDN | Global, fast, always on |

---

## Daily Workflow After Go-Live

1. Download master Excel from broker
2. Save as CSV UTF-8
3. Go to your site → Trades & Positions → Upload Master File
4. Select date → Upload → Data saves to Supabase instantly
5. Upload Bhavcopy for MTM prices

---

## If Something Goes Wrong

- **Site not loading**: Check Vercel dashboard for build errors
- **Data not saving**: Check the sync status in sidebar (bottom left)
- **Database error**: Go to Supabase → Logs to see what failed
- **Forgot something**: All your data is safe in Supabase — just redeploy

---

## Important — Keep These Safe (NEVER share publicly)

- Supabase Database Password
- Supabase anon key (already in your App.jsx — keep repo private!)
- Admin password: Jiya@3044 (change this periodically)
- GitHub repository (keep Private)
