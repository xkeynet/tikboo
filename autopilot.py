import os
import boto3
import yt_dlp
import sys
import time
from botocore.config import Config

# R2 Konfigurace
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
    # Unikátní název podle složky
    file_id = int(time.time())
    clean_name = f"{folder}_{file_id}.mp4"
    
    ydl_opts = {
        # HACKERSKÁ KOMPRESE: Vynutíme 720p a nižší datový tok pro úsporu místa
        # Používáme kodek avc1 (H.264), který je pro iPhone nejbezpečnější
        'format': 'bestvideo[height<=720][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best',
        'outtmpl': clean_name,
        'nocheckcertificate': True,
        'quiet': False,
        'postprocessor_args': [
            '-vcodec', 'libx264',
            '-crf', '28',        # Vyšší číslo = menší soubor (28 je ideální kompromis)
            '-preset', 'faster', # Rychlejší zpracování
            '-movflags', 'faststart' # KLÍČOVÉ: Přesune metadata na začátek videa pro streamování
        ],
    }

    try:
        print(f"Startuji stahování a kompresi: {url}")
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        
        remote_path = f"videos/{folder}/{clean_name}"
        
        # Nahrávání s kompletními hlavičkami pro Safari
        with open(clean_name, 'rb') as data:
            s3.put_object(
                Bucket='tikboo-media',
                Key=remote_path,
                Body=data,
                ContentType='video/mp4',
                ContentDisposition='inline',
                CacheControl='public, max-age=31536000'
            )

        print(f"BRUTÁLNÍ ÚSPĚCH! Video je v R2: {remote_path}")
        
        # Úklid po sobě
        if os.path.exists(clean_name):
            os.remove(clean_name)

    except Exception as e:
        print(f"CHYBA: {e}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) >= 3:
        download_and_upload(sys.argv[1], sys.argv[2])
