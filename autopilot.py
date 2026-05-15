import os
import boto3
import yt_dlp
import sys
import time
from botocore.config import Config

# r2 connection
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
    # Hack pro unikátní a krátký název souboru (swipe_čas.mp4)
    # Tímhle se zbavíme problémů s mezerami a diakritikou v URL
    clean_name = f"swipe_{int(time.time())}.mp4"
    
    ydl_opts = {
        'format': 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best',
        'outtmpl': clean_name, # Natvrdo čistý název
        'nocheckcertificate': True,
        'quiet': False,
        'http_headers': {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        }
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        
        remote_path = f"videos/{folder}/{clean_name}"
        
        # Nahrávání s brutálním vynucením typu videa
        with open(clean_name, 'rb') as data:
            s3.put_object(
                Bucket='tikboo-media',
                Key=remote_path,
                Body=data,
                ContentType='video/mp4',
                ContentDisposition='inline',
                CacheControl='max-age=31536000'
            )

        if os.path.exists(clean_name):
            os.remove(clean_name)
        print(f"Hotovo: {remote_path}")

    except Exception as e:
        print(f"Chyba: {e}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) >= 3:
        download_and_upload(sys.argv[1], sys.argv[2])
