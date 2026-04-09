# Fintech App - End-to-End Flow

This document describes how the app, backend, payments API, and OCR extraction pipeline work together.

## 1) Login Flow

1. App opens `LoginScreen`.
2. Login API call:
   - `POST {BACKEND_URL}/admin/login`
3. On success, app stores:
   - JWT token
   - user id
   - username
   - role
4. App navigates to `DashboardScreen`.

## 2) Dashboard Flow

When dashboard starts:

1. Requests SMS permission.
2. If granted:
   - Runs initial SMS sync (scan existing inbox + send to backend).
   - Starts continuous SMS listener (telephony) for new incoming SMS.

Available actions:

- **Sync Banking SMS**: manual inbox sync.
- **Read SMS**: opens parsed SMS list and bulk upload flow.
- **Payments**: fetches payment list using JWT.

## 3) SMS Read + Save Flow

### A) Initial/Manual Sync

1. App reads inbox SMS.
2. Filters likely banking messages.
3. Extracts structured fields:
   - `transactionType`
   - `amount`
   - `bankAccountLastFourDigits` / `accountLast4`
   - `utrNo`
   - `date`
   - `time`
   - `senderID` / `senderId`
   - `transactionId`
4. Sends to backend:
   - single: `POST /api/v1/sms-reader`
   - bulk: `POST /api/v1/sms-reader/bulk`

### B) Continuous Incoming SMS Listener

1. New SMS arrives.
2. App listener processes only banking SMS.
3. App sends SMS JSON to backend `/sms-reader`.
4. On successful save, app also triggers extraction pipeline:
   - `POST /api/v1/extract/bulk`
   - body includes JWT token.

## 4) Backend SMS Storage

Routes in `backend/routes/SmsReaderRoute.js`:

- `POST /sms-reader`
- `POST /sms-reader/bulk`
- `GET /sms-reader`
- `GET /sms-reader/:id`
- `DELETE /sms-reader/:id`

Controller behavior:

- Validates required SMS fields.
- Handles aliases (`senderId/senderID`, `accountLast4/bankAccountLastFourDigits`, etc.).
- Deduplicates and stores in `SmsReader` collection.
- Bulk endpoint accepts:
  - `smsList`
  - `records`
  - raw array

## 5) Payments API Flow

`PaymentScreen` calls:

- `GET {BACKEND_URL}/payments`
- Header: `Authorization: Bearer <JWT>`

It displays payments in app and uses same JWT for extraction trigger flow.

## 6) OCR Extraction Flow

Routes in `backend/routes/ExtractionRoute.js`:

- `POST /extract`
- `POST /extract/bulk`

Service in `backend/extraction.js`:

1. Uses Google Vision:
   - `https://vision.googleapis.com/v1/images:annotate`
   - `TEXT_DETECTION`
2. Extracts OCR text:
   - `responses[0].fullTextAnnotation.text`
3. Extracts:
   - UTR (12 digits): `\\b\\d{12}\\b`
   - Amount: `(?:₹|Rs\\.?|INR)\\s?([0-9,]+(?:\\.\\d{1,2})?)`
4. Bulk processing:
   - batch size max 10
   - parallel per batch using `Promise.all`
5. Handles failures:
   - OCR fail -> null values + `FAILED`
   - UTR/amount missing -> `FAILED`

## 7) Extraction Result Storage

Model: `backend/models/ExtractionResult.js`

Stored fields:

- `paymentId`
- `imageUrl` (unique)
- `utr`
- `amount`
- `status` (`SUCCESS` or `FAILED`)
- timestamps

Auto-save behavior:

- Extraction results are upserted by `imageUrl`.
- Existing URL updates existing record; new URL creates new record.

## 8) Required Environment Variables

### App (`app/.env`)

- `BACKEND_URL` (main auth/payments API base)
- `Backend_URL_LOCAL` (local backend base for sms/extract routes)

### Backend (`backend/.env`)

- `PORT`
- `MONGODB_URI`
- `Backend_URL`
- `Google_Vision_API_KEY`

## 9) Network Notes

- Backend listens on `0.0.0.0` for device access over LAN.
- For physical device testing, `Backend_URL_LOCAL` must use current laptop LAN IP.
- If laptop IP changes, update `app/.env` and restart app fully.

