import os
import boto3
import yt_dlp
from botocore.config import Config

# Propojení s tvým Cloudflare R2 pomocí klíčů, co už máš v Secrets
r2_config = Config(signature_version='s3v4')
s3 = boto3.client(
    's3',
    endpoint_url=os.environ.get('R2_ENDPOINT'),
    aws_access_key_id=os.environ.get('R2_ACCESS_KEY'),
    aws_secret_access_key=os.environ.get('R2_SECRET_KEY'),
    config=r2_config,
    region_name='auto'
)

def download_and_upload(url):
    print(f"🚀 Startuji proces pro: {url}")
    
    # Nastavení yt-dlp pro stažení videa
    ydl_opts = {'format': 'best', 'outtmpl': 'video.mp4'}
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])
    
    print("✅ Video staženo. Nahrávám na Cloudflare R2...")
    
    # Nahrání na tvůj R2 (bucket se jmenuje 'tikboo')
    s3.upload_file('video.mp4', 'tikboo', 'video-z-autopilota.mp4')
    print("✨ Mise splněna! Video je v cloudu.")

if __name__ == "__main__":
    url_videa = input("Vlož URL adresu videa: ")
    download_and_upload(url_videa)
