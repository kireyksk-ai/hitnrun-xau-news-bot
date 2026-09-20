# HitnRun XAU News Bot

Bot 24/7 untuk alur **news provider → seleksi OpenAI → Telegram private group**. Ia hanya mengirim katalis XAU yang material; berita yang ditolak dan yang sudah pernah diproses disimpan lokal agar tidak berulang setelah restart.

## Yang perlu disiapkan

1. Buat bot lewat `@BotFather`, lalu masukkan bot itu ke private group HitnRun FX sebagai admin dengan izin mengirim pesan.
2. Dapatkan `TELEGRAM_CHAT_ID` private group (umumnya bernilai negatif); kirim satu pesan di grup, lalu lihat respons `getUpdates` Bot API atau gunakan bot ID helper tepercaya.
3. Buat API key OpenAI dan akun/provider berita. Contoh adapter bawaan adalah NewsAPI.org.

## Jalan cepat

```bash
cp .env.example .env
# Isi OPENAI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, NEWSAPI_KEY
npm install
npm run dev
```

### Pengaturan paling mudah di Windows

Setelah semua key dibuat, ikuti [SETUP-UNTUK-KAMU.md](./SETUP-UNTUK-KAMU.md). Skrip pengaturan akan membuat `.env` dan mencari ID grup Telegram secara otomatis.

Untuk deploy terus-menerus dengan Docker:

```bash
docker compose up -d --build
docker compose logs -f
```

`restart: unless-stopped` menjaga bot hidup setelah host atau container restart. Jangan commit `.env` atau folder `data/`.

## Cara filter bekerja

Setiap artikel baru diperiksa oleh aturan editorial terpusat di `src/editor.ts`: prioritas Trump/Fed/macro AS/DXY-yield/oil/geopolitik/fiskal-trade; rumor, clickbait, cerita lama, dan noise dibuang. Narasi Telegram selalu bahasa Indonesia informal, tanpa link, daftar source, atau zona teknikal. Model diwajibkan menjelaskan jalur transmisi (yield/DXY/oil/risk/policy) dan tidak memakai kesimpulan otomatis tentang perang atau Fed.

Deduplication menggunakan fingerprint SHA-256 atas judul dan ringkasan yang dinormalisasi, disimpan selama 14 hari di `data/bot-store.json`. Artikel baru hanya dicatat **setelah** seleksi AI selesai; jika pengiriman Telegram gagal, artikel akan dicoba lagi pada siklus berikutnya.

## Menambah atau mengganti provider

Buat kelas baru di `src/providers/` yang mengimplementasikan interface `NewsProvider` dari `src/types.ts`, lalu daftarkan pada array `providers` di `src/index.ts`. Filter utama, dedup, dan Telegram tidak perlu diubah. Untuk feed yang benar-benar streaming (websocket/webhook), adapter dapat memanggil pipeline yang sama; polling bawaan 45 detik adalah opsi sederhana untuk provider REST.

Adapter Truth Social `@realDonaldTrump` tersedia dan dapat diperiksa setiap 15 detik, tetapi dinonaktifkan secara default karena endpoint publik dapat memblokir server atau berubah. Aktifkan hanya setelah provider/endpoint berizin telah tervalidasi; setiap post tetap melewati filter AI sebelum masuk Telegram.

## Catatan operasional

- Pastikan paket NewsAPI yang dipilih mengizinkan penggunaan produksi dan sumber yang Anda butuhkan.
- Mulai dengan `OPENAI_MODEL=gpt-5-mini`, lalu sesuaikan ke model yang tersedia di akun Anda bila perlu.
- Periksa log pada minggu pertama dan kalibrasikan prompt editorial bila terlalu ketat/longgar.
