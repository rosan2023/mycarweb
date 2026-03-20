import express from "express";
import morgan from "morgan";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dayjs from "dayjs";
import { body, matchedData, validationResult } from "express-validator";
import multer from "multer";
import session from "express-session";

import { db, getSettingsMap, seedDefaultSettings, setSetting, SETTINGS_KEYS, toInt, toIntOrNull } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

seedDefaultSettings();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(morgan("dev"));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(process.cwd(), "public")));

app.get("/favicon.ico", (req, res) => res.status(204).end());

app.use(
  session({
    name: "akmotors.sid",
    secret: process.env.SESSION_SECRET || "dev-only-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // set true behind HTTPS
      maxAge: 1000 * 60 * 60 * 12
    }
  })
);

const uploadsDir = path.join(process.cwd(), "public", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const safeBase = path
        .basename(file.originalname)
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(-120);
      const ext = path.extname(safeBase).toLowerCase();
      const base = safeBase.slice(0, safeBase.length - ext.length) || "image";
      cb(null, `${Date.now()}_${Math.round(Math.random() * 1e9)}_${base}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 10 }
});

app.use((req, res, next) => {
  const settings = getSettingsMap();
  res.locals.settings = settings;
  res.locals.appName = settings[SETTINGS_KEYS.COMPANY_NAME] || "AK Motors";
  res.locals.nowYear = new Date().getFullYear();
  res.locals.isAdmin = Boolean(req.session?.isAdmin);
  next();
});

function renderValidationErrors(req, res, view, data) {
  const result = validationResult(req);
  if (result.isEmpty()) return null;
  const errors = result.array({ onlyFirstError: true });
  return res.status(400).render(view, { ...data, errors });
}

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  const nextUrl = req.originalUrl || "/admin";
  return res.redirect(`/admin/login?next=${encodeURIComponent(nextUrl)}`);
}

// Public pages
app.get("/", (req, res) => {
  const cars = db
    .prepare(
      `SELECT
         c.id, c.title, c.make, c.model, c.year, c.price, c.mileage, c.status,
         ci.filename AS cover_image
       FROM cars c
       LEFT JOIN (
         SELECT car_id, filename
         FROM car_images
         WHERE id IN (SELECT MIN(id) FROM car_images GROUP BY car_id)
       ) ci ON ci.car_id = c.id
       WHERE status = 'AVAILABLE'
       ORDER BY c.created_at DESC`
    )
    .all();
  res.render("public/home", { cars });
});

app.get("/cars", (req, res) => {
  const cars = db
    .prepare(
      `SELECT
         c.id, c.title, c.make, c.model, c.year, c.price, c.mileage, c.status,
         ci.filename AS cover_image
       FROM cars c
       LEFT JOIN (
         SELECT car_id, filename
         FROM car_images
         WHERE id IN (SELECT MIN(id) FROM car_images GROUP BY car_id)
       ) ci ON ci.car_id = c.id
       ORDER BY c.created_at DESC`
    )
    .all();
  res.render("public/cars", { cars });
});

app.get("/cars/:id", (req, res) => {
  const id = toInt(req.params.id, 0);
  const car = db.prepare(`SELECT * FROM cars WHERE id = ?`).get(id);
  if (!car) return res.status(404).render("public/not-found", {});
  const images = db
    .prepare(`SELECT id, filename FROM car_images WHERE car_id = ? ORDER BY created_at ASC`)
    .all(id);
  res.render("public/car-detail", { car, images });
});

app.get("/contact", (req, res) => {
  const cars = db
    .prepare(`SELECT id, title, make, model, year FROM cars ORDER BY created_at DESC`)
    .all();
  res.render("public/contact", { cars, values: {}, errors: [] });
});

app.post(
  "/contact",
  body("name").trim().isLength({ min: 2 }).withMessage("Name is required."),
  body("email").trim().isEmail().withMessage("Valid email is required."),
  body("phone").optional({ checkFalsy: true }).trim().isLength({ min: 7 }).withMessage("Phone looks too short."),
  body("car_id").optional({ checkFalsy: true }).custom((v) => String(toInt(v, 0)) === String(v)).withMessage("Invalid car."),
  body("message").trim().isLength({ min: 5 }).withMessage("Message is required."),
  (req, res) => {
    const cars = db
      .prepare(`SELECT id, title, make, model, year FROM cars ORDER BY created_at DESC`)
      .all();
    const values = {
      name: req.body.name ?? "",
      email: req.body.email ?? "",
      phone: req.body.phone ?? "",
      car_id: req.body.car_id ?? "",
      message: req.body.message ?? ""
    };
    const err = renderValidationErrors(req, res, "public/contact", { cars, values });
    if (err) return;

    const data = matchedData(req, { locations: ["body"] });
    db.prepare(
      `INSERT INTO messages (name, email, phone, car_id, message)
       VALUES (@name, @email, @phone, @car_id, @message)`
    ).run({
      name: data.name,
      email: data.email,
      phone: data.phone ?? null,
      car_id: toIntOrNull(data.car_id),
      message: data.message
    });
    res.render("public/contact-success", {});
  }
);

// Admin auth
app.get("/admin/login", (req, res) => {
  res.render("admin/login", { next: req.query.next || "/admin", errors: [] });
});

app.post(
  "/admin/login",
  body("password").isString().withMessage("Password is required."),
  (req, res) => {
    const nextUrl = (req.body.next ? String(req.body.next) : "/admin") || "/admin";
    const password = String(req.body.password || "");

    const expected = process.env.ADMIN_PASSWORD || "admin123";
    if (password !== expected) {
      return res.status(401).render("admin/login", {
        next: nextUrl,
        errors: [{ msg: "Invalid password." }]
      });
    }

    req.session.isAdmin = true;
    res.redirect(nextUrl);
  }
);

app.post("/admin/logout", (req, res) => {
  req.session.isAdmin = false;
  req.session.destroy(() => res.redirect("/"));
});

// Admin (secured)
app.get("/admin", requireAdmin, (req, res) => {
  const counts = {
    cars: db.prepare(`SELECT COUNT(*) as n FROM cars`).get().n,
    available: db.prepare(`SELECT COUNT(*) as n FROM cars WHERE status='AVAILABLE'`).get().n,
    sold: db.prepare(`SELECT COUNT(*) as n FROM cars WHERE status='SOLD'`).get().n,
    messages: db.prepare(`SELECT COUNT(*) as n FROM messages`).get().n,
    sales: db.prepare(`SELECT COUNT(*) as n FROM sales`).get().n
  };
  res.render("admin/index", { counts });
});

// Admin settings
app.get("/admin/settings", requireAdmin, (req, res) => {
  const settings = getSettingsMap();
  res.render("admin/settings", { values: settings, errors: [] });
});

app.post(
  "/admin/settings",
  requireAdmin,
  body(SETTINGS_KEYS.COMPANY_NAME).trim().isLength({ min: 2 }).withMessage("Company name is required."),
  body(SETTINGS_KEYS.COMPANY_PHONE).trim().isLength({ min: 5 }).withMessage("Phone is required."),
  body(SETTINGS_KEYS.COMPANY_EMAIL).trim().isEmail().withMessage("Valid email is required."),
  body(SETTINGS_KEYS.COMPANY_ADDRESS).trim().isLength({ min: 2 }).withMessage("Address is required."),
  body(SETTINGS_KEYS.COMPANY_CURRENCY_CODE)
    .trim()
    .matches(/^[a-zA-Z]{3}$/)
    .withMessage("Currency code must be 3 letters (e.g. HKD, USD)."),
  body(SETTINGS_KEYS.COMPANY_CURRENCY_SYMBOL)
    .trim()
    .isLength({ min: 1, max: 8 })
    .withMessage("Currency symbol is required."),
  (req, res) => {
    const values = { ...req.body };
    const err = renderValidationErrors(req, res, "admin/settings", { values });
    if (err) return;

    const data = matchedData(req, { locations: ["body"] });
    setSetting(SETTINGS_KEYS.COMPANY_NAME, data[SETTINGS_KEYS.COMPANY_NAME]);
    setSetting(SETTINGS_KEYS.COMPANY_PHONE, data[SETTINGS_KEYS.COMPANY_PHONE]);
    setSetting(SETTINGS_KEYS.COMPANY_EMAIL, data[SETTINGS_KEYS.COMPANY_EMAIL]);
    setSetting(SETTINGS_KEYS.COMPANY_ADDRESS, data[SETTINGS_KEYS.COMPANY_ADDRESS]);
    setSetting(SETTINGS_KEYS.COMPANY_CURRENCY_CODE, String(data[SETTINGS_KEYS.COMPANY_CURRENCY_CODE]).toUpperCase());
    setSetting(SETTINGS_KEYS.COMPANY_CURRENCY_SYMBOL, data[SETTINGS_KEYS.COMPANY_CURRENCY_SYMBOL]);

    res.redirect("/admin/settings");
  }
);

// Cars CRUD
app.get("/admin/cars", requireAdmin, (req, res) => {
  const cars = db
    .prepare(
      `SELECT id, title, make, model, year, price, mileage, status, created_at
       FROM cars
       ORDER BY created_at DESC`
    )
    .all();
  res.render("admin/cars/list", { cars });
});

app.get("/admin/cars/new", requireAdmin, (req, res) => {
  res.render("admin/cars/form", { car: null, values: {}, errors: [], images: [] });
});

app.post(
  "/admin/cars",
  requireAdmin,
  body("title").trim().isLength({ min: 2 }).withMessage("Title is required."),
  body("make").trim().isLength({ min: 1 }).withMessage("Make is required."),
  body("model").trim().isLength({ min: 1 }).withMessage("Model is required."),
  body("year").trim().isInt({ min: 1950, max: 2050 }).withMessage("Year is invalid."),
  body("price").trim().isInt({ min: 0 }).withMessage("Price is invalid."),
  body("mileage").optional({ checkFalsy: true }).trim().isInt({ min: 0 }).withMessage("Mileage is invalid."),
  body("transmission").optional({ checkFalsy: true }).trim().isLength({ min: 2 }).withMessage("Transmission is too short."),
  body("fuel").optional({ checkFalsy: true }).trim().isLength({ min: 2 }).withMessage("Fuel is too short."),
  body("color").optional({ checkFalsy: true }).trim().isLength({ min: 2 }).withMessage("Color is too short."),
  body("description").optional({ checkFalsy: true }).trim().isLength({ min: 5 }).withMessage("Description is too short."),
  (req, res) => {
    const values = { ...req.body };
    const err = renderValidationErrors(req, res, "admin/cars/form", { car: null, values });
    if (err) return;

    const data = matchedData(req, { locations: ["body"] });
    db.prepare(
      `INSERT INTO cars (title, make, model, year, price, mileage, transmission, fuel, color, description)
       VALUES (@title, @make, @model, @year, @price, @mileage, @transmission, @fuel, @color, @description)`
    ).run({
      title: data.title,
      make: data.make,
      model: data.model,
      year: toInt(data.year),
      price: toInt(data.price),
      mileage: toIntOrNull(data.mileage),
      transmission: data.transmission ?? null,
      fuel: data.fuel ?? null,
      color: data.color ?? null,
      description: data.description ?? null
    });
    const newId = db.prepare(`SELECT last_insert_rowid() as id`).get().id;
    res.redirect(`/admin/cars/${newId}/edit`);
  }
);

app.get("/admin/cars/:id/edit", requireAdmin, (req, res) => {
  const id = toInt(req.params.id, 0);
  const car = db.prepare(`SELECT * FROM cars WHERE id = ?`).get(id);
  if (!car) return res.status(404).render("admin/not-found", {});
  const images = db
    .prepare(`SELECT id, filename FROM car_images WHERE car_id = ? ORDER BY created_at ASC`)
    .all(id);
  res.render("admin/cars/form", { car, values: car, errors: [], images });
});

app.post(
  "/admin/cars/:id",
  requireAdmin,
  body("title").trim().isLength({ min: 2 }).withMessage("Title is required."),
  body("make").trim().isLength({ min: 1 }).withMessage("Make is required."),
  body("model").trim().isLength({ min: 1 }).withMessage("Model is required."),
  body("year").trim().isInt({ min: 1950, max: 2050 }).withMessage("Year is invalid."),
  body("price").trim().isInt({ min: 0 }).withMessage("Price is invalid."),
  body("mileage").optional({ checkFalsy: true }).trim().isInt({ min: 0 }).withMessage("Mileage is invalid."),
  body("status").trim().isIn(["AVAILABLE", "SOLD"]).withMessage("Status is invalid."),
  (req, res) => {
    const id = toInt(req.params.id, 0);
    const car = db.prepare(`SELECT * FROM cars WHERE id = ?`).get(id);
    if (!car) return res.status(404).render("admin/not-found", {});

    const values = { ...req.body, id };
    const err = renderValidationErrors(req, res, "admin/cars/form", { car, values });
    if (err) return;

    const data = matchedData(req, { locations: ["body"] });
    db.prepare(
      `UPDATE cars
       SET title=@title, make=@make, model=@model, year=@year, price=@price, mileage=@mileage,
           transmission=@transmission, fuel=@fuel, color=@color, description=@description, status=@status
       WHERE id=@id`
    ).run({
      id,
      title: data.title,
      make: data.make,
      model: data.model,
      year: toInt(data.year),
      price: toInt(data.price),
      mileage: toIntOrNull(data.mileage),
      transmission: data.transmission ?? null,
      fuel: data.fuel ?? null,
      color: data.color ?? null,
      description: data.description ?? null,
      status: data.status
    });
    res.redirect(`/admin/cars/${id}/edit`);
  }
);

app.post("/admin/cars/:id/delete", requireAdmin, (req, res) => {
  const id = toInt(req.params.id, 0);
  db.prepare(`DELETE FROM cars WHERE id = ?`).run(id);
  res.redirect("/admin/cars");
});

// Car images
app.post("/admin/cars/:id/images", requireAdmin, upload.array("images", 10), (req, res) => {
  const carId = toInt(req.params.id, 0);
  const car = db.prepare(`SELECT id FROM cars WHERE id = ?`).get(carId);
  if (!car) return res.status(404).render("admin/not-found", {});

  const files = Array.isArray(req.files) ? req.files : [];
  const insert = db.prepare(`INSERT INTO car_images (car_id, filename) VALUES (?, ?)`);
  const tx = db.transaction(() => {
    for (const f of files) insert.run(carId, f.filename);
  });
  tx();

  res.redirect(`/admin/cars/${carId}/edit`);
});

app.post("/admin/cars/:id/images/:imageId/delete", requireAdmin, (req, res) => {
  const carId = toInt(req.params.id, 0);
  const imageId = toInt(req.params.imageId, 0);
  const img = db.prepare(`SELECT id, filename FROM car_images WHERE id = ? AND car_id = ?`).get(imageId, carId);
  if (img) {
    db.prepare(`DELETE FROM car_images WHERE id = ?`).run(imageId);
    const filePath = path.join(uploadsDir, img.filename);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // ignore file delete issues; DB row already removed
    }
  }
  res.redirect(`/admin/cars/${carId}/edit`);
});

// Messages
app.get("/admin/messages", requireAdmin, (req, res) => {
  const messages = db
    .prepare(
      `SELECT m.*, c.title AS car_title
       FROM messages m
       LEFT JOIN cars c ON c.id = m.car_id
       ORDER BY m.created_at DESC`
    )
    .all();
  res.render("admin/messages/list", { messages, dayjs });
});

app.post("/admin/messages/:id/delete", requireAdmin, (req, res) => {
  const id = toInt(req.params.id, 0);
  db.prepare(`DELETE FROM messages WHERE id = ?`).run(id);
  res.redirect("/admin/messages");
});

// Sales + reports
app.get("/admin/sales", requireAdmin, (req, res) => {
  const cars = db
    .prepare(`SELECT id, title, make, model, year, price, status FROM cars ORDER BY created_at DESC`)
    .all();
  const sales = db
    .prepare(
      `SELECT s.*, c.title AS car_title, c.make, c.model, c.year
       FROM sales s
       JOIN cars c ON c.id = s.car_id
       ORDER BY s.sold_at DESC`
    )
    .all();
  res.render("admin/sales/list", { cars, sales, dayjs, values: {}, errors: [] });
});

app.post(
  "/admin/sales",
  requireAdmin,
  body("car_id").trim().isInt({ min: 1 }).withMessage("Car is required."),
  body("sold_price").trim().isInt({ min: 0 }).withMessage("Sold price is invalid."),
  body("sold_at").optional({ checkFalsy: true }).trim().isISO8601().withMessage("Sold date is invalid."),
  body("buyer_name").optional({ checkFalsy: true }).trim().isLength({ min: 2 }).withMessage("Buyer name is too short."),
  (req, res) => {
    const cars = db
      .prepare(`SELECT id, title, make, model, year, price, status FROM cars ORDER BY created_at DESC`)
      .all();
    const sales = db
      .prepare(
        `SELECT s.*, c.title AS car_title, c.make, c.model, c.year
         FROM sales s
         JOIN cars c ON c.id = s.car_id
         ORDER BY s.sold_at DESC`
      )
      .all();

    const values = { ...req.body };
    const err = renderValidationErrors(req, res, "admin/sales/list", { cars, sales, dayjs, values });
    if (err) return;

    const data = matchedData(req, { locations: ["body"] });
    const carId = toInt(data.car_id);

    db.transaction(() => {
      db.prepare(
        `INSERT INTO sales (car_id, sold_price, sold_at, buyer_name, notes)
         VALUES (@car_id, @sold_price, @sold_at, @buyer_name, @notes)`
      ).run({
        car_id: carId,
        sold_price: toInt(data.sold_price),
        sold_at: data.sold_at ?? dayjs().toISOString(),
        buyer_name: data.buyer_name ?? null,
        notes: (req.body.notes ?? "").trim() || null
      });
      db.prepare(`UPDATE cars SET status='SOLD' WHERE id = ?`).run(carId);
    })();

    res.redirect("/admin/sales");
  }
);

app.get("/admin/reports/monthly", requireAdmin, (req, res) => {
  const month = (req.query.month ? String(req.query.month) : dayjs().format("YYYY-MM")).slice(0, 7);
  const start = `${month}-01`;
  const end = dayjs(start).add(1, "month").format("YYYY-MM-01");

  const rows = db
    .prepare(
      `SELECT s.id, s.sold_at, s.sold_price, c.title, c.make, c.model, c.year
       FROM sales s
       JOIN cars c ON c.id = s.car_id
       WHERE s.sold_at >= ? AND s.sold_at < ?
       ORDER BY s.sold_at DESC`
    )
    .all(start, end);

  const total = rows.reduce((sum, r) => sum + (r.sold_price ?? 0), 0);
  res.render("admin/reports/monthly", { month, rows, total, dayjs });
});

app.use((req, res) => res.status(404).render("public/not-found", {}));

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`AK Motors running on http://localhost:${port}`);
});

