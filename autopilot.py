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
    print(f"🚀 Startuji stahování: {url}")
    
    cookie_path = 'cookies.txt'
    
    # 2. Hackerské nastavení pro Instagram (iPhone 16 maskování)
    ydl_opts = {
        'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        'outtmpl': '%(title)s.%(ext)s',
        'quiet': False,
        'cookiefile': cookie_path if os.path.exists(cookie_path) else None,
        'nocheckcertificate': True,
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'cs-CZ,cs;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': 'https://www.instagram.com/',
        }
    }

    if not os.path.exists(cookie_path):
        print("⚠️ Poznámka: cookies.txt je prázdný, zkouším pokročilé maskování iPhonu...")

    try:
        # 3. Stažení videa
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(info)
        
        # 4. Cesta v Cloudflare R2
        remote_path = f"videos/{folder}/{filename}"
        
        print(f"✅ Staženo: {filename}")
        print(f"📦 Nahrávám na R2: {remote_path}")
        
        # 5. Upload na R2 s nastavením správného typu souboru
        s3.upload_file(
            filename, 
            'tikboo-media', 
            remote_path, 
            ExtraArgs={'ContentType': 'video/mp4'}
        )
        print("✨ Mise splněna! Video je v R2.")

        # Úklid
        if os.path.exists(filename):
            os.remove(filename)

    except Exception as e:
        print(f"❌ Došlo k chybě: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) >= 3:
        url_videa = sys.argv[1]
        typ_videa = sys.argv[2]
        download_and_upload(url_videa, typ_videa)
    else:
        print("❌ Chyba: Chybí URL nebo složka.")
        sys.exit(1)
