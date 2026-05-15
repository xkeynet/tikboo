import os
import boto3
import yt_dlp
import sys
from botocore.config import Config

# 1. Konfigurace pro Cloudflare R2
r2_config = Config(signature_version='s3v4')
s3 = boto3.client(
    's3',
    endpoint_url=os.environ.get('R2_ENDPOINT'),
    aws_access_key_id=os.environ.get('R2_ACCESS_KEY'),
    aws_secret_access_key=os.environ.get('R2_SECRET_KEY'),
    config=r2_config,
    region_name='auto'
)

def download_and_upload(url, folder):
    print(f"🚀 Startuji proces pro: {url}")
    print(f"📁 Cílová složka: {folder}")
    
    cookie_path = 'cookies.txt'
    
    # 2. Inteligentní nastavení stahování
    # 'bestvideo+bestaudio/best' zajistí nejvyšší možnou kvalitu
    ydl_opts = {
        'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        'outtmpl': '%(title)s.%(ext)s',
        'quiet': False,
        'nocheckcertificate': True,
        'cookiefile': cookie_path if os.path.exists(cookie_path) else None,
    }

    # 3. Rozlišení logiky podle typu obsahu
    # Pokud jde o Instagram, přidáme specifické maskování prohlížeče
    if "instagram.com" in url:
        print("📸 Detekován Instagram - aplikuji mobilní maskování...")
        ydl_opts['http_headers'] = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Referer': 'https://www.instagram.com/',
        }
    else:
        print("🌐 Detekován Adult/Ostatní obsah - nastavuji maximální propustnost...")
        # Pro Adult stránky často stačí standardní UA, aby nedocházelo k chybám
        ydl_opts['user_agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

    try:
        # 4. Samotné stažení
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(info)
        
        # 5. Cesta v Cloudflare R2
        remote_path = f"videos/{folder}/{filename}"
        
        print(f"✅ Staženo: {filename}")
        print(f"📦 Nahrávám na Cloudflare R2...")
        
        # 6. Upload s fixem pro přehrávání v prohlížeči
        s3.upload_file(
            filename, 
            'tikboo-media', 
            remote_path, 
            ExtraArgs={
                'ContentType': 'video/mp4',
                'ContentDisposition': 'inline' # Fix pro okamžité přehrávání
            }
        )
        print(f"✨ Hotovo! Video je dostupné v: {remote_path}")

        # Úklid lokálního souboru
        if os.path.exists(filename):
            os.remove(filename)

    except Exception as e:
        print(f"❌ Chyba v autopilotu: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) >= 3:
        url_videa = sys.argv[1]
        typ_slozky = sys.argv[2]
        download_and_upload(url_videa, typ_slozky)
    else:
        print("❌ Chyba: Nedostatečné parametry (URL nebo složka).")
        sys.exit(1)
