import os
import boto3
import yt_dlp
import sys
from botocore.config import Config

# Konfigurace pro Cloudflare R2
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
    
    # Nastavení pro stahování - získáme info o videu předem
    ydl_opts = {
        'format': 'best',
        'outtmpl': '%(title)s.%(ext)s', # Použije název videa z webu
        'quiet': False
    }
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        filename = ydl.prepare_filename(info)
    
    # Cesta v Cloudflare R2 - dáváme do podsložky podle tvého výběru
    remote_path = f"videos/{folder}/{filename}"
    
    print(f"✅ Staženo: {filename}")
    print(f"📦 Nahrávám na R2: {remote_path}")
    
    s3.upload_file(filename, 'tikboo-media', remote_path)
    print("✨ Mise splněna! Video je v bezpečí v cloudu.")

if __name__ == "__main__":
    # Robot (GitHub Actions) posílá argumenty sem:
    if len(sys.argv) >= 3:
        url_videa = sys.argv[1]
        typ_videa = sys.argv[2]
        download_and_upload(url_videa, typ_videa)
    else:
        print("❌ Chyba: Chybí URL nebo složka. Robot nedostal správná data.")
        sys.exit(1)
