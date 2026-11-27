# AutoCare Backend API

Backend API untuk aplikasi AutoCare menggunakan Express.js, MySQL (`mysql2`), Nodemailer, dan Midtrans.

Repository GitHub: `https://github.com/Tuan-Raza/backend-autocare.git`

---

## 1. Cara Pasang dari GitHub ke VS Code

1. Buka **VS Code**.
2. Tekan `Ctrl + Shift + P`, ketik **`Git: Clone`**, lalu tekan `Enter`.
3. Masukkan URL repository:
   ```text
   https://github.com/Tuan-Raza/backend-autocare.git
   ```
4. Pilih folder tujuan di komputer (misalnya `C:\laragon\www\AutoCare_Lengkap\backend`), lalu klik **Open** saat VS Code menawarkan membuka foldernya.
   *(Atau lewat terminal: `git clone https://github.com/Tuan-Raza/backend-autocare.git backend`)*
5. Buka terminal di VS Code (`Ctrl + ` `), lalu install dependensi:
   ```bash
   npm install
   ```

> **Mengambil update terbaru dari GitHub:**
> ```bash
> git pull origin main
> ```

---

## 2. Cara Menjalankan

### Prasyarat
- **Node.js** sudah terinstall.
- **MySQL** aktif (misalnya lewat **Laragon**).

### Langkah-langkah
1. Salin file `.env.example` menjadi `.env`, lalu sesuaikan isinya:
   ```env
   DB_HOST=localhost
   DB_USER=root
   DB_PASSWORD=
   DB_NAME=autocare_database
   DB_PORT=3306

   PORT=5000

   EMAIL_USER=your_email@gmail.com
   EMAIL_PASS=your_app_password

   MIDTRANS_CLIENT_KEY=your_client_key
   MIDTRANS_SERVER_KEY=your_server_key
   MIDTRANS_IS_PRODUCTION=false
   ```
2. Pastikan database MySQL sesuai `DB_NAME` sudah dibuat di Laragon / phpMyAdmin / HeidiSQL.
3. Jalankan server:
   - **Mode development (auto-restart dengan nodemon):**
     ```bash
     npm run dev
     ```
   - **Mode standar:**
     ```bash
     npm start
     ```
4. Server akan berjalan di `http://localhost:5000` (atau sesuai `PORT` di `.env`).

### Menjalankan Unit Test
```bash
npm test
```

---

## 3. Cara Upload / Push Perubahan ke GitHub

Pastikan terminal berada di dalam folder `backend`:

```bash
# 1. Cek file yang berubah
git status

# 2. Masukkan semua perubahan ke staging
git add .

# 3. Simpan commit dengan pesan yang jelas
git commit -m "deskripsi perubahan"

# 4. (Opsional) Tarik update terbaru jika ada perubahan di GitHub
git pull origin main

# 5. Upload ke GitHub
git push origin main
```

> **Catatan:** File `.env` dan `node_modules/` jangan ikut di-push ke GitHub (pastikan sudah masuk `.gitignore`).
