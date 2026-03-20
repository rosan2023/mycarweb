# AK Motors (Car Dealer Website)

Full-stack starter website for a car dealer with:

- Car listings (**CRUD**)
- Contact form + messages (**CRUD/view/delete**)
- Record car sales
- Monthly sales report

## Requirements

- Node.js 20+ (recommended)

## Setup

From `c:\Users\Haashim\Documents\akmotors`:

```powershell
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Admin security (login)

Admin pages are now protected.

- Login at `/admin/login`
- Set your password via environment variable:

```powershell
$env:ADMIN_PASSWORD="your-strong-password"
$env:SESSION_SECRET="another-strong-secret"
npm run dev
```



## Uploading car images

- Go to `Admin → Cars → Edit car`
- Use the **Images** section to upload photos
- Images are stored in `public/uploads/` and linked to the car in the database

## Pages

- Public:
  - `/` Home (available cars)
  - `/cars` Inventory
  - `/cars/:id` Car details + quick message form
  - `/contact` Contact page (saves messages)
- Admin (no login yet in this starter):
  - `/admin` Dashboard
  - `/admin/cars` Cars CRUD
  - `/admin/messages` View/delete messages
  - `/admin/sales` Record sales (auto-marks car as SOLD)
  - `/admin/reports/monthly` Monthly revenue report

## Data

SQLite database file is created automatically at:

- `data/akmotors.sqlite`

