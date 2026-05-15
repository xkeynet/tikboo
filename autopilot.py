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
    # Název bude teď čistě: adult_171576445.mp4 nebo insta_171576445.mp4
    file_id = int(time.time())
    clean_name = f"{folder}_{file_id}.mp4"
    
    ydl_opts = {
        'format': 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best',
        'outtmpl': clean_name,
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
        
        # NAHRÁVÁNÍ S FIXEM PRO SAFARI (Metadata a ContentType)
        with open(clean_name, 'rb') as data:
            s3.put_object(
                Bucket='tikboo-media',
                Key=remote_path,
                Body=data,
                ContentType='video/mp4',
                ContentDisposition='inline',
                CacheControl='public, max-age=31536000',
                Metadata={
                    'accept-ranges': 'bytes'
                }
            )

        if os.path.exists(clean_name):
            os.remove(clean_name)
        print(f"Hotovo! Uloženo jako: {remote_path}")

    except Exception as e:
        print(f"Chyba: {e}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) >= 3:
        download_and_upload(sys.argv[1], sys.argv[2])
