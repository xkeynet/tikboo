import os
import boto3
import yt_dlp
import sys
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
    cookie_path = 'cookies.txt'
    
    # HACK: Vynucení MP4 kontejneru, který Safari miluje
    ydl_opts = {
        'format': 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best',
        'outtmpl': 'video.%(ext)s', # Pojmenujeme to jednoduse, aby nebyl problem s diakritikou
        'nocheckcertificate': True,
        'quiet': True,
        'cookiefile': cookie_path if os.path.exists(cookie_path) else None,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(info)
        
        # Cesta v R2
        remote_path = f"videos/{folder}/{filename}"
        
        # BRUTAL HACK: Vynucení hlaviček přímo při uploadu
        # 'video/mp4' musí být přesně takhle, aby Safari vědělo, co s tím
        with open(filename, 'rb') as data:
            s3.put_object(
                Bucket='tikboo-media',
                Key=remote_path,
                Body=data,
                ContentType='video/mp4',
                ContentDisposition='inline',
                CacheControl='max-age=31536000'
            )

        if os.path.exists(filename):
            os.remove(filename)
    except Exception:
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) >= 3:
        download_and_upload(sys.argv[1], sys.argv[2])
