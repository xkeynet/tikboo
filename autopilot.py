import os
import boto3
import yt_dlp
import sys
from botocore.config import Config

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
    print(f"🚀 Startuji: {url}")
    print(f"📂 Cílová složka: videos/{folder}/")
    
    # Nastavení pro stahování
    filename = "video.mp4"
    ydl_opts = {'format': 'best', 'outtmpl': filename}
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])
    
    # Cesta v Cloudflare R2
    remote_path = f"videos/{folder}/{filename}"
    
    print(f"✅ Staženo. Nahrávám na R2 do: {remote_path}")
    s3.upload_file(filename, 'tikboo-media', remote_path)
    print("✨ Mise splněna! Video je v cloudu.")

if __name__ == "__main__":
    # Pokud spouštíme přes robota, bere si data z argumentů, jinak se zeptá
    url_videa = sys.argv[1] if len(sys.argv) > 1 else input("Vlož URL adresu videa: ")
    typ_videa = sys.argv[2] if len(sys.argv) > 2 else input("Zadej složku (insta/adult): ")
    
    download_and_upload(url_videa, typ_videa)
