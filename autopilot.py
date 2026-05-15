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
    
    # HACK: Vynuceni 720p a mp4 formatu pro brutalni usporu mista a maximalni kompatibilitu
    ydl_opts = {
        'format': 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best',
        'outtmpl': '%(title)s.%(ext)s',
        'nocheckcertificate': True,
        'quiet': True,
        'cookiefile': cookie_path if os.path.exists(cookie_path) else None,
        'http_headers': {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        }
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(info)
        
        # r2 pathing: videos/adult/ nebo videos/insta/
        remote_path = f"videos/{folder}/{filename}"
        
        # HEADERS HACK: inline + mp4 content type pro okamzity stream
        s3.upload_file(
            filename, 
            'tikboo-media', 
            remote_path, 
            ExtraArgs={
                'ContentType': 'video/mp4',
                'ContentDisposition': 'inline'
            }
        )

        if os.path.exists(filename):
            os.remove(filename)
    except Exception:
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) >= 3:
        download_and_upload(sys.argv[1], sys.argv[2])
