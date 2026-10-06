# BEN Froid Adrar

E-commerce storefront for refrigeration, air conditioning, and home appliances in Adrar, Algeria.

## Features
- Product catalog and category browsing
- Shopping cart and checkout flow
- Order tracking and admin dashboard
- Delivery rates for Algerian wilayas
- Arabic and English interface
- Production-ready Express + Vite setup

## Prerequisites
- Node.js 18+
- npm 9+

## Local setup
1. Install dependencies:
   `npm install`
2. Copy environment variables:
   `cp .env.example .env`
3. Fill in your real values in `.env`
4. Start the app:
   `npm run dev`

## Production build
```bash
npm run build
```

## Production start
```bash
npm start
```

## Security
- Do not commit any real `.env` or `.env.local` files.
- Keep secret keys in deployment platform environment variables, not in Git.
- Use `.env.example` as the safe template.

## Deployment
This project is ready for deployment on Vercel, Railway, or any Node.js hosting provider.
