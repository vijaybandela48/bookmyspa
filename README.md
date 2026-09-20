# SpaBook — Spa & Massage Booking Platform

A working full-stack marketplace for spa/massage bookings — customers browse spas,
book a time slot, and pay online; spa owners manage their listing, services and
incoming bookings; admins approve new spas and see platform-wide stats.

## Why this runs instantly, with zero setup

The backend is written using **only Node.js's built-in modules** — `node:http`,
`node:sqlite`, and `node:crypto`. There is no `npm install` step, no external
database server, and no third-party auth library. This means:

- It runs anywhere Node 22+ is installed, with no internet connection required.
- The full stack (DB + API + auth + frontend) is ~1,500 lines of plain,
  readable code — easy for you or a developer to extend.
- When you're ready to scale, swap SQLite for Postgres and the mock payment
  gateway for a real one (see below) — the rest of the app doesn't change.

## Quick start

```bash
cd server
node server.js
```

Then open **http://localhost:3000** in your browser. That's it — no build step.

A demo database is pre-seeded with 4 spas (across Hyderabad and Bangalore) and
these logins:

| Role     | Email                     | Password    |
|----------|---------------------------|-------------|
| Customer | customer@spabook.demo     | customer123 |
| Owner    | owner1@spabook.demo       | owner123    |
| Owner    | owner2@spabook.demo       | owner123    |
| Admin    | admin@spabook.demo        | admin123    |

To start over with a clean database, delete `data/spa_platform.db` and restart
the server — it will reseed automatically.

## What's included (working, end-to-end)

**Customer side**
- Browse/search spas by city or keyword
- Sort spas by **Featured**, **Top rated**, or **Nearby** — Nearby asks for browser location permission and sorts by real distance (Haversine formula), showing "X km away" on each card
- View a spa's services, pick a date, see real-time slot availability (with rooms-left indicators when a service has limited capacity)
- Apply a coupon code at checkout to see the discount before paying
- Choose how to receive booking confirmation — Email, SMS, or WhatsApp — at checkout
- **Choose how to pay: online now, or at the spa.** Paying online runs through the real payment flow below. Choosing "Pay at the spa" reserves the slot and confirms the booking immediately with no online charge — the customer pays cash/card/UPI in person, and the spa owner marks it paid afterward from their dashboard.
- Book a slot — booking confirms instantly and a confirmation message is sent on the chosen channel
- View/cancel bookings ("My bookings"), including which channel the confirmation was sent on and whether payment is still due at the spa

**Spa owner side**
- Register a spa (goes live after admin approval)
- **Set the spa's location** with one tap ("Use my current location") or by entering coordinates manually — required for the spa to appear under customers' "Nearby" sort. Existing spas can have their location added/updated anytime, with a "View on map" link once set.
- Add/remove services with price and duration
- **Room/capacity management**: define room types (e.g. "2 Jacuzzi Rooms", "3 Therapy Rooms") and assign each service to one. Customers can then book up to that many overlapping slots — the 4th customer trying to book a 3-room therapy slot correctly sees it as full, while other room types stay unaffected.
- **Coupons**: create promo codes with a percentage or flat discount, optionally restricted to a date range, a time window, a specific service, and/or a max redemption count. Coupon discounts stack on top of any service-level discount.
- Upload photos and short videos of the spa (up to 12 files, 15MB each — JPG/PNG/WEBP/GIF or MP4/WEBM/MOV). The first photo becomes the listing's cover image automatically; you can change the cover or delete files anytime.
- Set a discount on any service (0–90%). Customers see the original price struck through next to the discounted price, and are charged the discounted amount at checkout.
- View incoming bookings with customer contact info, mark as completed
- **Collect and record pay-at-spa payments**: the Bookings tab shows a running total of how much is still owed in cash/card/UPI across all upcoming pay-at-spa bookings. "Mark as paid" records exactly how the customer paid, for a clean reconciliation trail alongside your online payments.

**Admin side**
- Approve/reject new spa listings
- Platform-wide stats (spas, users, bookings, revenue)
- View all bookings and all users

**Platform mechanics**
- Real password hashing (scrypt) + signed session tokens (HMAC, JWT-style) — no
  third-party auth library needed
- Slots are generated dynamically from each spa's opening hours + service
  duration, and correctly blocked once booked (double-booking is prevented)
- A pending (unpaid) booking auto-releases the slot after 10 minutes if not
  paid for

## Architecture

```
spa-platform/
├── server/
│   ├── server.js       # HTTP server: serves the frontend + routes /api/*
│   ├── db.js            # SQLite schema + seed data
│   ├── auth.js           # Password hashing, signed tokens, auth middleware
│   ├── api.js             # All REST API route handlers
│   ├── payments/
│   │   └── gateway.js      # Razorpay payments (mock mode until keys are set)
│   └── notifications/
│       └── notifier.js      # Email/SMS/WhatsApp confirmations (mock, swappable)
├── public/               # Frontend: plain HTML/CSS/JS, no framework, no build step
│   ├── index.html          # Browse spas (Featured / Top rated / Nearby)
│   ├── spa.html             # Spa detail, booking, payment, coupons
│   ├── login.html / register.html
│   ├── account.html          # Customer's bookings
│   ├── owner/index.html       # Owner dashboard (spas, rooms, coupons, media, location)
│   ├── admin/index.html        # Admin dashboard
│   ├── css/style.css
│   ├── js/api.js               # Shared fetch helper + session handling
│   └── uploads/spas/             # Owner-uploaded spa photos/videos (auto-created)
└── data/
    └── spa_platform.db          # SQLite database file (auto-created)
```

## Going live with real customers and real payments

This app now ships with production-grade payment handling, not just a demo —
here's exactly what's already done for you, and the handful of things only
you can do (business registration, legal pages, etc).

### Already built — just needs your credentials

1. **Real payments via Razorpay.** `server/payments/gateway.js` and the
   `/api/bookings/:id/checkout` + `/api/bookings/:id/verify` endpoints
   implement the full real flow: create an order server-side, open Razorpay's
   hosted checkout (card/UPI details never touch this server, which is what
   keeps you out of PCI-DSS scope), then verify the HMAC signature Razorpay
   returns before ever marking a booking as paid. Refunds on cancellation use
   Razorpay's real refund API too. All of this runs in safe **mock mode**
   with zero setup until you set:
   ```
   RAZORPAY_KEY_ID=rzp_live_xxxxxxxx
   RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxx
   ```
   Get these from your Razorpay dashboard after their KYC/business
   verification (a few days — see below). Test with `rzp_test_...` keys
   first.
2. **A webhook safety net.** `POST /api/webhooks/razorpay` independently
   confirms a booking even if a customer closes their browser tab right
   after paying (a real failure mode — the client-side `/verify` call never
   fires, but the customer *was* charged). Point a webhook at
   `https://yourdomain.com/api/webhooks/razorpay` in the Razorpay dashboard,
   set `RAZORPAY_WEBHOOK_SECRET` to match, done. Safe to skip initially — the
   checkout flow works without it.
3. **Real notifications.** `server/notifications/notifier.js` sends booking
   confirmations in mock mode by default. Set these to go live (no npm
   install needed, everything uses the built-in `fetch`):
   - `RESEND_API_KEY` (+ optionally `RESEND_FROM`) for real email via [Resend](https://resend.com)
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM` for real SMS via [Twilio](https://twilio.com)
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` for real WhatsApp via Twilio

   Set only the channels you need — anything without credentials stays mocked.
4. **Session security.** The server now **refuses to start** in
   `NODE_ENV=production` unless you set a real `TOKEN_SECRET` (a long random
   string — running on the built-in dev default would let anyone forge a
   valid login session, including admin). Generate one with:
   ```
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
5. **No public demo passwords in production.** In `NODE_ENV=production`, the
   app no longer creates the 4 demo accounts whose passwords are printed in
   this README — that would be a real vulnerability on a live deployment.
   Instead it creates exactly one admin account from environment variables:
   ```
   ADMIN_EMAIL=you@yourbusiness.com
   ADMIN_PASSWORD=<a strong password>
   ```
   If you forget to set these, the server still boots but logs a clear
   warning and creates no admin at all — register a normal account and
   promote it to admin directly in the database as a fallback.
6. **Brute-force protection.** Login and signup are now rate-limited
   (10 login attempts / 15 min, 8 signups / hour, per IP) — enough to stop
   automated credential-stuffing without needing a separate service like
   Cloudflare, though adding one is still a good idea at scale.
7. **Basic security headers** (X-Frame-Options, X-Content-Type-Options,
   HSTS in production) are set on every response.

### Still on you — these can't be coded around

- **Razorpay business verification (KYC)**: your business registration,
  bank account details, and PAN/GST get verified before they issue live
  keys — budget a few business days for this, start it early.
- **Legal pages**: a Terms of Service, Privacy Policy, and a visible
  Refund/Cancellation Policy — Razorpay actually requires the last one to
  approve your account, and it protects you when a customer disputes a
  charge.
- **Data protection compliance**: if you're in India, the DPDP Act applies
  to storing customer names/phone/email — have a lawyer glance at your
  privacy policy rather than relying on a template.
- **Backups**: automate regular backups of `data/spa_platform.db` and
  `public/uploads/` to somewhere off the server (S3, Backblaze, etc). SQLite
  itself is reliable; losing the one file it lives in is the actual risk.
- **Monitoring**: set up uptime alerts (e.g. UptimeRobot, Better Stack) and
  keep an eye on server logs for `[MOCK ...]` lines — that's your sign a
  notification or payment channel isn't actually configured yet, even after
  "going live" on the others.

### Other infrastructure notes

- **Database**: SQLite is genuinely fine for low-to-medium traffic
  (thousands of bookings/day) on a single server. Move to Postgres/MySQL
  only if you outgrow a single-server deployment — the SQL in `db.js`/`api.js`
  is close to standard SQL already.
- **Maps**: spa locations are stored as plain lat/lng and linked out to
  Google Maps. For an embedded map, add a mapping provider's JS SDK
  (Leaflet/Mapbox/Google Maps) — left out to keep the app dependency-free by
  default.
- **HTTPS + deployment**: deploy behind a reverse proxy (Nginx/Caddy) with
  TLS, e.g. on Render, Railway, a VPS, or AWS/GCP. See the hosting section
  below.

## Hosting this online

This app needs three things from a host: **Node.js 22.5+** (for the built-in
SQLite module), a way to **set environment variables**, and — this is the one
easy-to-miss part — **persistent disk storage**, because both the SQLite
database (`data/spa_platform.db`) and owner-uploaded photos/videos
(`public/uploads/`) are plain files. A host that wipes the filesystem on every
deploy (most "serverless"/edge platforms) will silently lose all bookings and
uploads on the next push.

### Easiest: Railway or Render (a few dollars a month)
1. Push this folder to a GitHub repo.
2. Create a new project on [Railway](https://railway.com) or
   [Render](https://render.com) and connect that repo. Both auto-detect
   `package.json` and run `npm start`.
3. **Attach a persistent volume/disk** mounted at the project root (or at
   least covering `data/` and `public/uploads/`) — this is a paid-plan
   feature on both platforms; skip it and your data won't survive a redeploy.
4. Set the `TOKEN_SECRET` environment variable to a long random string (this
   signs login sessions — don't run production on the built-in dev default).
   Optionally add `RESEND_API_KEY` / `TWILIO_*` variables if you want real
   email/SMS/WhatsApp confirmations instead of the mock ones.
5. Add a custom domain from the platform's dashboard once it's live — both
   handle HTTPS automatically.

### Cheapest / most control: a small VPS (e.g. Hetzner, DigitalOcean, ~$5/mo)
1. Spin up an Ubuntu server, `ssh` in, install Node 22+ (`nvm install 22` is
   the easiest way, or your distro's Node 22 package).
2. Copy this folder to the server (`git clone` or `scp`).
3. Run it persistently with a process manager, e.g.
   `npm install -g pm2 && pm2 start server/server.js --name spabook && pm2 save`.
4. Put [Nginx](https://nginx.org) in front as a reverse proxy to port 3000,
   then run `certbot --nginx` for a free HTTPS certificate on your domain.
5. Since everything lives on local disk already, there's no separate volume
   to configure — just make sure regular backups cover `data/` and
   `public/uploads/`.

Either way, do a final check after deploying: create a test booking and
confirm it's still there after a restart/redeploy — that's the surest sign
persistent storage is actually wired up correctly.

## Extending it

- Ratings/reviews: add a `reviews` table + a couple of endpoints — the
  `spas.rating` column already exists.
- Recurring/multi-day packages, loyalty points, coupons: layer on top of the
  `bookings` table.
- Push the frontend to React/Vue later if you want a richer UI — the API is
  already a clean REST layer that any frontend can call.
