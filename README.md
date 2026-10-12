# BeatBox — Simple Music App (Hinglish)

Kya milta hai:
- Signup / Login (JWT)
- Admin account (ENV se) jo songs upload karega
- Stream (seekable) aur download (Premium users)
- Razorpay order+verify flow, aur fallback payment link agar keys nahi diye

Setup (local):
1. Node 18+ install karo.
2. Repo clone karo ya zip download karo.
3. `npm install` in the project root.
4. `.env.example` ko `.env` copy karo aur values set karo.
   - Agar aap server-side Razorpay chahte ho toh RAZORPAY_KEY_ID aur RAZORPAY_KEY_SECRET set karo (test keys use karo).
   - Nahi toh PAYMENT_LINK ko `.env` me rakh lo (default aapka link already set hai).
5. `npm start`
6. Open: http://localhost:3000

Admin:
- Server start hone par agar ADMIN_EMAIL/ADMIN_PASSWORD `.env` me diye hain to admin user auto-create ho jayega.
- Admin login karo — uploads dikhenge.

Payments:
- Agar RAZORPAY keys configured hain: frontend `/api/pay/order` se order leke Razorpay checkout chalega, fir `/api/pay/verify` call karke premium milta hai.
- Agar keys nahi hain: `/api/pay/order` fallback me PAYMENT_LINK return karega (ya direct redirect `/pay`).

Storage:
- Local dev me files `DATA_DIR/uploads` me save hote hain. Production me S3/MinIO use karo.

Security & Prod tips:
- `.env` commit mat karo.
- Use HTTPS (required for real payments).
- Move DB to Postgres & files to S3 for scale.
- Use webhooks for authoritative payment verification in production.

Aage kya karna hai:
- Agar chaho to main is repo ko GitHub pe push kar doon.
- Ya main aapke liye: S3 + Postgres migration, Razorpay webhooks, or nicer frontend (React) bana dunga.

Bas batao — main push kar doon ya aur kuch add karun?
