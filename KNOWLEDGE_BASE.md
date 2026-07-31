# 📗 The B Hive Resort — WhatsApp Automation & CRM Knowledge Base (KB)

> **Document Version:** 1.0  
> **Repository:** [Kishan0029/bhive-chat-dashboard](https://github.com/Kishan0029/bhive-chat-dashboard)  
> **Live Production Dashboard:** [https://chat.thebhiveresort.in](https://chat.thebhiveresort.in)  
> **n8n Workflow Engine:** `http://localhost:5678`

---

## 1. Executive Summary & Architecture Overview

The B Hive Resort WhatsApp Automation system is an enterprise-grade conversational AI and live customer relationship management (CRM) dashboard. It bridges automated AI guest handling with seamless human takeover by the resort owner.

```
Guest (WhatsApp) <--> Meta Graph API v20.0 <--> Node.js (/api/webhook) <--> Supabase (PostgreSQL)
                                                        |
                                                        +--> Socket.io <--> Live Web UI (chat.thebhiveresort.in)
                                                        |
n8n AI Workflow <-------------------+--> POST /api/check-takeover
```

### Core Technologies
1. **Conversational Engine (n8n):** Self-hosted AI workflow orchestration handling guest inquiries, pricing, and stay types.
2. **Central State & Socket.io Backend (`server.js`):** Node.js server managing WhatsApp webhooks, name detection, human takeover state, and real-time frontend syncing.
3. **Database (`Supabase / PostgreSQL`):** Persists all conversations, contact names, takeover statuses, and message histories.
4. **Live Web Dashboard (`index.html`):** Apple/Linear-inspired CRM interface optimized for both desktop and mobile devices.
5. **Secure Routing (`Cloudflare Tunnel - cloudflared`):** Routes `https://chat.thebhiveresort.in` directly to `localhost:3000`.

---

## 2. Core Functional Workflows

### 🤖 AI vs. 🧑‍💼 Human Takeover Control (`/api/check-takeover`)
- **How it works:** Before n8n generates an AI response to an incoming WhatsApp message, it sends a `POST /api/check-takeover` request with the guest's phone number.
- **Takeover Active (`takeover: true`):** If the resort owner has clicked **"Takeover from AI"** in the web dashboard, the endpoint returns `{ "takeover": true }`. The n8n workflow routes to `Is Human Takeover? -> true` and pauses AI generation so the owner can converse manually without AI interference.
- **AI Active (`takeover: false`):** The AI agent replies automatically until the owner steps in.

### ⚡ Instant Guest Name Auto-Detection (`autoDetectGuestName`)
- **Proactive Extraction:** As soon as a guest types their name (e.g., `"name: Narendra Modi"`, `"I am Rahul"`), `server.js` extracts the name immediately—without waiting for the end of the inquiry flow.
- **Real-Time Sync:** The detected name is saved to Supabase and broadcasted via Socket.io (`contact_name_updated`) to all connected Web UI clients instantly.
- **Phone Number Format:** Standardized to E.164 without a leading `+` symbol (e.g., `919876543210`) for all webhook and API interactions.

### 🏷️ Lead Status Pipeline & Minimalist UI Badges
The dashboard automatically categorizes guest conversations based on keyword detection in conversation history:
| Lead Category | Trigger Keywords | Sidebar UI (LED Dot) | Chat Header UI |
| :--- | :--- | :---: | :--- |
| **🟢 Booking Lead** | `"new enquiry"`, `"review your enquiry"`, `"enquiry has been sent"`, `"make an enquiry"` | `🟢` Green 8px LED Dot | `🟢 Booking Lead` Pill |
| **🟡 VIP Group (6+)** | `"adults: 6+"`, `"corporate"`, `"wedding"`, `"groups above 6"` | `🟡` Gold 8px LED Dot | `🟡 VIP Group` Pill |
| **🔴 Human Needed** | Human Takeover manually toggled ON | `🔴` Red 8px LED Dot | `🔴 Human Needed` Pill |
| **🔵 Browsing (Default)** | General questions or initial contact | *Zero Clutter (Hidden)* | *Hidden* |

---

## 3. Web Dashboard UI/UX Specifications

### Apple / Linear CRM Aesthetic
- **Sidebar Minimalist LED Dots:** Actionable chats display only an 8px glowing LED dot (`.sidebar-led-dot`) with custom drop-shadows next to the guest name. No text labels clutter the sidebar list.
- **2-Line Flat Mobile Header (`#chat-header`):**
  - Enforced `flex-wrap: nowrap` on both header lines to prevent 3-line or 4-line text wrapping on narrow screens.
  - **Duplicate Number Suppression:** When a guest has not yet provided their name (display name defaults to `91...`), the subtitle phone number is hidden to avoid repeating `918431157922` and `+918431157922`.

---

## 4. API Endpoints Reference (`server.js`)

| Endpoint | Method | Payload / Params | Description |
| :--- | :---: | :--- | :--- |
| `/api/webhook` | `POST` | Meta Graph API JSON payload | Ingestion endpoint for WhatsApp messages and delivery statuses. |
| `/api/check-takeover` | `POST` | `{ "phone": "91..." }` | Called by n8n to check if Human Takeover is active for a contact. |
| `/api/takeover` | `POST` | `{ "phone": "91...", "takeover": true }` | Toggles human takeover state; saves to Supabase and emits Socket.io event. |
| `/api/send` | `POST` | `{ "phone": "91...", "text": "..." }` | Sends manual WhatsApp replies from the resort owner to the guest. |

---

## 5. Startup & System Launch Guide (After PC Restart)

Whenever the host PC is restarted, three services must run simultaneously for the automation and web dashboard to be operational.

### 🌟 Preferred Method: 1-Click Batch Script
Double-click the startup script located in the project root:
```
e:\08_Miscellanious Projects\The B Hive Resort Whatsapp Automation\START_BHIVE_SYSTEM.bat
```
This automatically opens three command windows and starts:
1. **n8n Workflow Engine** (`http://localhost:5678`)
2. **Node.js Web Dashboard** (`http://localhost:3000`)
3. **Cloudflare Live Tunnel** (`https://chat.thebhiveresort.in`)

### 💻 Manual Command Line Method (PowerShell)
Open PowerShell and launch each service in a separate terminal tab:
```powershell
# Tab 1: n8n Server (MUST pass WEBHOOK_URL so WhatsApp API trigger activates without errors)
$env:WEBHOOK_URL="https://api.thebhiveresort.in"; $env:N8N_WEBHOOK_URL="https://api.thebhiveresort.in"; n8n

# Tab 2: Node.js Web Dashboard Server
cd "e:\08_Miscellanious Projects\The B Hive Resort Whatsapp Automation"
node server.js

# Tab 3: Cloudflare Public HTTPS Tunnel
cd "e:\08_Miscellanious Projects\The B Hive Resort Whatsapp Automation"
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel run thebhiveresort
```

---

## 6. Troubleshooting & Diagnostics

- **Issue: `api.thebhiveresort.in` displays Cloudflare "502 Bad Gateway" OR n8n logs show `"Bad request - please check your parameters"` during workflow activation**
  - **Cause:** When n8n is started without `WEBHOOK_URL=https://api.thebhiveresort.in`, it attempts to register `http://localhost:5678` as the webhook URL with the Meta WhatsApp Cloud API. Meta rejects non-HTTPS localhost URLs, causing n8n to get stuck in an infinite activation retry loop.
  - **Fix:** Always launch n8n using `START_BHIVE_SYSTEM.bat` (which sets `WEBHOOK_URL=https://api.thebhiveresort.in` automatically) or pass `$env:WEBHOOK_URL="https://api.thebhiveresort.in"` before running `n8n`.
- **Issue: `chat.thebhiveresort.in` displays Cloudflare "502 Bad Gateway"**
  - **Cause:** Cloudflare tunnel is running, but `node server.js` is not active on port 3000.
  - **Fix:** Launch `node server.js` in your project folder.
- **Issue: n8n workflows fail to trigger or reply**
  - **Cause:** n8n server is offline after restart.
  - **Fix:** Run `n8n` in terminal or double-click `START_BHIVE_SYSTEM.bat`.
- **Issue: Guest names not updating in Web UI automatically**
  - **Cause:** Socket.io client disconnection or Supabase credentials error.
  - **Fix:** Verify `.env` file contains correct `SUPABASE_URL` and `SUPABASE_KEY`, then reload Web UI.
