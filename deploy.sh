#!/bin/bash

# --- ANKYY.COM DEPLOYMENT SCRIPT ---
# Usage: ./deploy.sh

echo "🚀 STARTING DEPLOYMENT..."

# 1. Pull latest code
echo "📥 Pulling from GitHub..."
git pull origin main

# 2. Install Backend Dependencies & Restart Engine
echo "⚙️ Updating Backend..."
cd backend
npm install
# (Optional: Only restart if server.js changed, but safer to restart always)
pm2 restart musicbox-api
cd ..

# 3. Rebuild Frontend (Only if needed, but we force it to be safe)
echo "🎨 Building Frontend..."
cd frontend
npm install
npm run build
cd ..

# 4. Rebuild Admin Panel
echo "👑 Building Admin Panel..."
cd admin
npm install
npm run build
cd ..

# 5. Permission Fix (The Nginx Fix)
echo "🔒 Fixing Permissions..."
sudo chown -R www-data:www-data /var/www/ankyy.com

echo "✅ DEPLOYMENT COMPLETE! Site is live."