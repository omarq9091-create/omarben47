import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

import { INITIAL_PRODUCTS, INITIAL_CATEGORIES, INITIAL_SETTINGS } from './src/data/initialData.ts';
import { ALGERIA_WILAYAS, getDefaultDeliveryRates } from './src/data/wilayas.ts';
import { Product, Category, Order, Customer, DeliveryRate, StoreSettings, OrderStatus } from './src/types/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || 'admin,superadmin,benfroid')
  .split(',')
  .map((u) => u.trim().toLowerCase())
  .filter(Boolean);

if (!ADMIN_PASSWORD) {
  console.warn('WARNING: ADMIN_PASSWORD is not set. Define it in your environment before deploying to production.');
}

app.use(express.json());

// Persistent database path
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'store_db.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

interface DatabaseSchema {
  products: Product[];
  categories: Category[];
  orders: Order[];
  customers: Customer[];
  deliveryRates: DeliveryRate[];
  settings: StoreSettings;
  adminPassword?: string;
}

function loadAndSeedDatabase(): DatabaseSchema {
  let loadedDb: Partial<DatabaseSchema> = {};
  try {
    if (fs.existsSync(DB_FILE)) {
      const content = fs.readFileSync(DB_FILE, 'utf-8');
      loadedDb = JSON.parse(content);
    }
  } catch (err) {
    console.error('Error reading store_db.json, initializing defaults:', err);
  }

  let hasChanged = false;

  // Seed Products if empty
  const products: Product[] = (loadedDb.products && loadedDb.products.length > 0)
    ? loadedDb.products
    : (hasChanged = true, [...INITIAL_PRODUCTS]);

  // Seed Categories if empty
  const categories: Category[] = (loadedDb.categories && loadedDb.categories.length > 0)
    ? loadedDb.categories
    : (hasChanged = true, [...INITIAL_CATEGORIES]);

  // Seed 58 Delivery Rates if empty
  const deliveryRates: DeliveryRate[] = (loadedDb.deliveryRates && loadedDb.deliveryRates.length > 0)
    ? loadedDb.deliveryRates
    : (hasChanged = true, getDefaultDeliveryRates());

  // Seed Settings if empty
  const settings: StoreSettings = (loadedDb.settings && loadedDb.settings.storeName)
    ? loadedDb.settings
    : (hasChanged = true, { ...INITIAL_SETTINGS });

  const orders: Order[] = loadedDb.orders || [];
  const customers: Customer[] = loadedDb.customers || [];
  const adminPassword = loadedDb.adminPassword || ADMIN_PASSWORD;

  const fullDb: DatabaseSchema = {
    products,
    categories,
    orders,
    customers,
    deliveryRates,
    settings,
    adminPassword,
  };

  if (hasChanged || !fs.existsSync(DB_FILE)) {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(fullDb, null, 2), 'utf-8');
      console.log('Database initialized and seeded in', DB_FILE);
    } catch (e) {
      console.error('Failed writing initial DB:', e);
    }
  }

  return fullDb;
}

function saveDatabase(dbData: DatabaseSchema) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing store_db.json:', err);
  }
}

let db = loadAndSeedDatabase();

// ----------------------------------------------------
// Health Check
// ----------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    store: 'BEN FROID ADRAR',
    productsCount: db.products.length,
    ordersCount: db.orders.length,
    time: new Date().toISOString(),
  });
});

// ----------------------------------------------------
// Products API
// ----------------------------------------------------
app.get('/api/products', (_req, res) => {
  res.json(db.products);
});

app.post('/api/products', (req, res) => {
  const newProduct: Product = req.body;
  if (!newProduct.id) {
    newProduct.id = `prod_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  }
  db.products.unshift(newProduct);
  saveDatabase(db);
  res.status(201).json(newProduct);
});

app.put('/api/products/:id', (req, res) => {
  const { id } = req.params;
  const updatedProduct: Product = req.body;
  const index = db.products.findIndex((p) => p.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'المنتج غير موجود' });
  }
  db.products[index] = { ...db.products[index], ...updatedProduct };
  saveDatabase(db);
  res.json(db.products[index]);
});

app.delete('/api/products/:id', (req, res) => {
  const { id } = req.params;
  db.products = db.products.filter((p) => p.id !== id);
  saveDatabase(db);
  res.json({ success: true, id });
});

// ----------------------------------------------------
// Categories & Brands
// ----------------------------------------------------
app.get('/api/categories', (_req, res) => {
  res.json(db.categories);
});

app.get('/api/brands', (_req, res) => {
  const brands = Array.from(new Set(db.products.map((p) => p.brand).filter(Boolean)));
  res.json(brands);
});

// ----------------------------------------------------
// Delivery Rates (58 Wilayas)
// ----------------------------------------------------
app.get('/api/delivery-rates', (_req, res) => {
  res.json(db.deliveryRates);
});

app.put('/api/delivery-rates/:code', (req, res) => {
  const code = Number(req.params.code);
  const { price, estimatedDays, isAvailable } = req.body;
  const rate = db.deliveryRates.find((r) => r.wilayaCode === code);
  if (!rate) {
    return res.status(404).json({ error: 'الولاية غير موجودة' });
  }
  if (typeof price === 'number') rate.price = price;
  if (estimatedDays) rate.estimatedDays = estimatedDays;
  if (typeof isAvailable === 'boolean') rate.isAvailable = isAvailable;
  saveDatabase(db);
  res.json(rate);
});

// ----------------------------------------------------
// Orders API with Server-Side Validation & Stock Protection
// ----------------------------------------------------
app.get('/api/orders', (_req, res) => {
  res.json(db.orders);
});

app.get('/api/orders/:id', (req, res) => {
  const { id } = req.params;
  const order = db.orders.find((o) => o.id === id || o.orderNumber === id);
  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });
  res.json(order);
});

// Public Track Order endpoint
app.get('/api/orders/track/:orderNumber', (req, res) => {
  const { orderNumber } = req.params;
  const cleanNum = (orderNumber || '').trim().toUpperCase();
  const order = db.orders.find(
    (o) => o.orderNumber.toUpperCase() === cleanNum || o.id === cleanNum
  );
  if (!order) {
    return res.status(404).json({
      success: false,
      error: 'لم يتم العثور على أي طلب برقم التتبع المدخل. يرجى التأكد من الرقم (مثال: BF-20261005-0001).',
    });
  }

  // Return tracking info
  res.json({
    success: true,
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      createdAt: order.createdAt,
      customerName: order.customerName,
      wilayaName: order.wilayaName,
      commune: order.commune,
      status: order.status,
      items: order.items,
      subtotal: order.subtotal,
      deliveryCost: order.deliveryCost,
      total: order.total,
      paymentMethod: order.paymentMethod,
    },
  });
});

app.post('/api/orders', (req, res) => {
  try {
    const {
      customerName,
      phone,
      phoneSecondary,
      wilayaCode,
      commune,
      address,
      notes,
      items,
    } = req.body;

    // 1. Basic validation
    if (!customerName || !customerName.trim()) {
      return res.status(400).json({ success: false, error: 'يرجى إدخال اسم العميل واللقب.' });
    }
    const cleanPhone = (phone || '').replace(/\D/g, '');
    if (!cleanPhone || cleanPhone.length < 9) {
      return res.status(400).json({ success: false, error: 'يرجى إدخال رقم هاتف صحيح للتواصل والتأكيد.' });
    }
    if (!wilayaCode) {
      return res.status(400).json({ success: false, error: 'يرجى اختيار ولاية التوصيل.' });
    }
    if (!commune || !commune.trim()) {
      return res.status(400).json({ success: false, error: 'يرجى تحديد أو كتابة البلدية.' });
    }
    if (!address || !address.trim()) {
      return res.status(400).json({ success: false, error: 'يرجى كتابة العنوان التفصيلي لتسهيل التوصيل.' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'سلة المشتريات فارغة.' });
    }

    // 2. Server-side product price & stock validation
    let subtotal = 0;
    const verifiedItems = [];

    for (const item of items) {
      const prodId = item.productId || item.product?.id;
      const requestedQty = Number(item.quantity) || 1;

      const product = db.products.find((p) => p.id === prodId);
      if (!product) {
        return res.status(400).json({
          success: false,
          error: `المنتج المختار لم يعد متوفراً في المتجر.`,
        });
      }

      // Check stock
      if (product.stockQuantity < requestedQty) {
        return res.status(400).json({
          success: false,
          error: `الكمية المطلوبة (${requestedQty}) غير متوفرة من المنتج: "${product.name}". المتوفر حالياً بالمخزن: ${product.stockQuantity} فقط.`,
        });
      }

      // Deduct stock
      product.stockQuantity = Math.max(0, product.stockQuantity - requestedQty);
      if (product.stockQuantity === 0) {
        product.inStock = false;
      }

      // Price calculation on server side strictly
      const itemTotal = product.price * requestedQty;
      subtotal += itemTotal;

      verifiedItems.push({
        productId: product.id,
        productName: product.name,
        reference: product.reference,
        price: product.price,
        quantity: requestedQty,
        total: itemTotal,
        imageUrl: product.imageUrl,
      });
    }

    // 3. Server-side delivery rate lookup
    const codeNum = Number(wilayaCode);
    const rate = db.deliveryRates.find((r) => r.wilayaCode === codeNum);
    const wilayaObj = ALGERIA_WILAYAS.find((w) => w.code === codeNum);
    const deliveryCost = rate ? rate.price : (wilayaObj ? wilayaObj.defaultPrice : 500);
    const wilayaName = wilayaObj ? wilayaObj.nameAr : `ولاية ${codeNum}`;

    const total = subtotal + deliveryCost;

    // 4. Sequential Order Number Generator: BF-YYYYMMDD-0001
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dateStr = `${year}${month}${day}`;

    const todayOrderCount = db.orders.filter(
      (o) => o.orderNumber && o.orderNumber.startsWith(`BF-${dateStr}`)
    ).length;

    const orderSeq = String(todayOrderCount + 1).padStart(4, '0');
    const orderNumber = `BF-${dateStr}-${orderSeq}`;

    // 5. Construct Order Object
    const newOrder: Order = {
      id: `ord_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      orderNumber,
      createdAt: now.toISOString(),
      customerName: customerName.trim(),
      phone: phone.trim(),
      phoneSecondary: phoneSecondary ? phoneSecondary.trim() : undefined,
      wilayaCode: codeNum,
      wilayaName,
      commune: commune.trim(),
      address: address.trim(),
      notes: notes ? notes.trim() : undefined,
      items: verifiedItems,
      subtotal,
      deliveryCost,
      total,
      paymentMethod: 'cod',
      status: 'new',
    };

    // 6. Customer CRM tracking
    const cleanCustomerPhone = phone.replace(/\D/g, '');
    let customer = db.customers.find(
      (c) => c.phone.replace(/\D/g, '') === cleanCustomerPhone
    );

    if (!customer) {
      customer = {
        id: `cust_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        name: customerName.trim(),
        phone: phone.trim(),
        wilaya: wilayaName,
        commune: commune.trim(),
        address: address.trim(),
        totalOrders: 1,
        totalSpent: total,
        lastOrderDate: now.toISOString(),
      };
      db.customers.unshift(customer);
    } else {
      customer.name = customerName.trim();
      customer.totalOrders = (customer.totalOrders || 0) + 1;
      customer.totalSpent = (customer.totalSpent || 0) + total;
      customer.lastOrderDate = now.toISOString();
      customer.wilaya = wilayaName;
      customer.commune = commune.trim();
      customer.address = address.trim();
    }

    db.orders.unshift(newOrder);
    saveDatabase(db);

    console.log(`[ORDER CREATED] ${newOrder.orderNumber} - ${newOrder.customerName} - Total: ${newOrder.total} DZD`);

    res.status(201).json({
      success: true,
      order: newOrder,
      updatedProducts: db.products,
    });
  } catch (err: any) {
    console.error('Order creation error:', err);
    res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء معالجة الطلب.' });
  }
});

// Update order status with stock restoration on cancellation
app.put('/api/orders/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body as { status: OrderStatus };

  const validStatuses: OrderStatus[] = ['new', 'processing', 'prepared', 'shipped', 'delivered', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'حالة الطلب غير صالحة.' });
  }

  const order = db.orders.find((o) => o.id === id || o.orderNumber === id);
  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });

  const prevStatus = order.status;
  order.status = status;

  // If cancelling order, restore stock
  if (prevStatus !== 'cancelled' && status === 'cancelled') {
    for (const item of order.items) {
      const prod = db.products.find((p) => p.id === item.productId);
      if (prod) {
        prod.stockQuantity += item.quantity;
        if (prod.stockQuantity > 0) prod.inStock = true;
      }
    }
  }

  saveDatabase(db);
  res.json({ success: true, id: order.id, orderNumber: order.orderNumber, status });
});

// ----------------------------------------------------
// Customers API
// ----------------------------------------------------
app.get('/api/customers', (_req, res) => {
  res.json(db.customers);
});

// ----------------------------------------------------
// Admin Real-Time KPI Stats API
// ----------------------------------------------------
app.get('/api/stats', (_req, res) => {
  const validOrders = db.orders.filter((o) => o.status !== 'cancelled');
  const totalSales = validOrders.reduce((sum, o) => sum + (o.total || 0), 0);

  const stats = {
    totalSales,
    totalOrders: db.orders.length,
    newOrders: db.orders.filter((o) => o.status === 'new').length,
    processingOrders: db.orders.filter((o) => o.status === 'processing').length,
    preparedOrders: db.orders.filter((o) => o.status === 'prepared').length,
    shippedOrders: db.orders.filter((o) => o.status === 'shipped').length,
    deliveredOrders: db.orders.filter((o) => o.status === 'delivered').length,
    cancelledOrders: db.orders.filter((o) => o.status === 'cancelled').length,
    totalProducts: db.products.length,
    totalCustomers: db.customers.length,
  };

  res.json(stats);
});

// ----------------------------------------------------
// Settings API
// ----------------------------------------------------
app.get('/api/settings', (_req, res) => {
  res.json(db.settings);
});

app.put('/api/settings', (req, res) => {
  db.settings = { ...db.settings, ...req.body };
  saveDatabase(db);
  res.json(db.settings);
});

// ----------------------------------------------------
// Admin Auth & Security
// ----------------------------------------------------
let failedAttempts = 0;
let lockUntilTime = 0;

app.post('/api/admin/login', (req, res) => {
  const now = Date.now();
  if (now < lockUntilTime) {
    const remainingSeconds = Math.ceil((lockUntilTime - now) / 1000);
    return res.status(429).json({
      success: false,
      message: `تم حظر محاولات الدخول مؤقتاً لكثرة المحاولات الخاطئة. يرجى الانتظار ${remainingSeconds} ثانية.`,
    });
  }

  const { username, password } = req.body;
  const targetUser = (username || '').trim().toLowerCase();
  const inputPwd = (password || '').trim();

  const storedPassword = (db.settings as any)?.adminPassword || db.adminPassword || ADMIN_PASSWORD;
  const isUserValid = ADMIN_USERNAMES.includes(targetUser) || targetUser === 'staff';
  const isPasswordValid = inputPwd === storedPassword;

  if (isUserValid && isPasswordValid) {
    failedAttempts = 0;
    const token = `bf_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

    res.json({
      success: true,
      token,
      username: targetUser,
      role: targetUser === 'staff' ? 'staff' : 'superadmin',
      expiresAt,
    });
  } else {
    failedAttempts += 1;
    if (failedAttempts >= 5) {
      lockUntilTime = Date.now() + 30 * 1000;
      failedAttempts = 0;
      return res.status(429).json({
        success: false,
        message: 'تم تجاوز الحد الأقصى للمحاولات الخاطئة. تم قفل المحاولات لمدة 30 ثانية لأسباب أمنية.',
      });
    }

    res.status(401).json({
      success: false,
      message: 'بيانات الدخول غير صحيحة. يرجى التحقق من اسم المستخدم وكلمة المرور.',
      remainingAttempts: 5 - failedAttempts,
    });
  }
});

app.get('/api/admin/verify', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ valid: false });
  }
  const token = authHeader.replace('Bearer ', '');
  if (token && token.startsWith('bf_')) {
    return res.json({ valid: true });
  }
  return res.status(401).json({ valid: false });
});

app.post('/api/admin/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const storedPassword = (db.settings as any)?.adminPassword || db.adminPassword || ADMIN_PASSWORD;

  if (currentPassword !== storedPassword) {
    return res.status(401).json({
      success: false,
      message: 'كلمة المرور الحالية غير صحيحة.',
    });
  }

  if (!newPassword || newPassword.length < 5) {
    return res.status(400).json({
      success: false,
      message: 'كلمة المرور الجديدة يجب أن تحتوي على 5 أحرف أو أرقام على الأقل.',
    });
  }

  db.adminPassword = newPassword;
  if (!db.settings) db.settings = {} as any;
  (db.settings as any).adminPassword = newPassword;
  saveDatabase(db);

  res.json({
    success: true,
    message: 'تم تغيير كلمة مرور المسؤول بنجاح.',
  });
});

// ----------------------------------------------------
// Static Assets / Vite Dev Server
// ----------------------------------------------------
async function startServer() {
  if (!isProduction) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`BEN FROID ADRAR server running on port ${PORT} (production: ${isProduction})`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
