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
    # Unikátní název podle času a složky
    file_id = int(time.time())
    clean_name = f"{folder}_{file_id}.mp4"
    
    ydl_opts = {
        # 720p pro iPhone a nejlepší kompatibilitu
        'format': 'bestvideo[height<=720][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best',
        'outtmpl': clean_name,
        'nocheckcertificate': True,
        
        # --- HACKERSKÁ VSUVKA PROTI BLOKOVÁNÍ (HTTP 404) ---
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.google.com/',
        },
        # --------------------------------------------------

        'postprocessor_args': [
            '-vcodec', 'libx264',
            '-crf', '28',        # Brutální komprese (úspora peněz)
            '-preset', 'faster',
            '-movflags', 'faststart' # Klíčové pro okamžité spuštění v Safari
        ],
    }

    try:
        print(f"Spouštím stahování s maskováním: {url}")
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        
        remote_path = f"videos/{folder}/{clean_name}"
        
        # Nahrávání do R2
        with open(clean_name, 'rb') as data:
            s3.put_object(
                Bucket='tikboo-media',
                Key=remote_path,
                Body=data,
                ContentType='video/mp4',
                ContentDisposition='inline',
                CacheControl='public, max-age=31536000'
            )

        # Úklid lokálního souboru
        if os.path.exists(clean_name):
            os.remove(clean_name)
        print(f"Hotovo: {remote_path}")

    except Exception as e:
        print(f"Chyba: {e}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) >= 3:
        download_and_upload(sys.argv[1], sys.argv[2])
