# Obsyncian — affordable encrypted sync

Sync your Obsidian vault across devices without configuring buckets or servers. Built for people priced out of other options: generous storage, and you can pay with a card, USDT, or rubles.

- **End-to-end encrypted.** With a passphrase set, file contents *and file paths* are encrypted on your device (AES-256-GCM, PBKDF2 key derivation) before upload. We store only ciphertext and opaque IDs — we cannot read your notes, and neither can our storage provider.
- **Zero setup.** Log in with an email code, link your vault, done.
- **Conflict-safe.** Concurrent edits never overwrite each other — the other version is saved next to the file as `Name (conflict …).md`.
- **Works on desktop and mobile.** Syncs while the app is open (mobile platforms don't allow background sync).

## Disclosures (per Obsidian developer policies)

- **Account required.** The plugin talks to the Obsyncian API (`obsyncian.com` by default) for authentication and sync metadata, and transfers file data directly to Cloudflare R2 object storage via short-lived signed URLs. No other network services are used.
- **Payment.** A free tier (100 MB) is available; larger storage requires a paid subscription purchased outside the plugin. Sync stops accepting new data when you exceed your quota; existing data stays downloadable.
- **Server code.** The plugin is open source (MIT). The server implementation is currently closed-source; its API and this plugin's encryption code are fully auditable here.
- **Telemetry.** The plugin sends no telemetry. Server-side we keep operational logs (account email, request metadata, storage usage) as described in the [privacy policy](https://obsyncian.com/privacy).
- **Warning about lost passphrases.** End-to-end encryption means a lost passphrase makes your synced data unrecoverable. Keep local copies or remember it.

## Getting started

1. Install and enable the plugin, then open **Settings → Obsyncian**.
2. Enter your email, press **Send code**, and enter the 6-digit code from your inbox.
3. Optionally set an encryption passphrase (strongly recommended).
4. Create a synced vault (or link an existing one from another device).

Sync runs automatically on changes and on an interval; use the **Obsyncian: Sync now** command to force one.

## Self-hosting

The API server is a small Rails app storing metadata in SQLite and blobs in any S3-compatible bucket. Point **Server URL** in settings at your instance.
