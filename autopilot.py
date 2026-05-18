import os
import sys
import json
import re
import subprocess
import boto3
from botocore.client import Config

def extract_video_id(url):
    # Vyčistí URL a vytáhne unikátní ID videa pro název souboru
    if "viewkey=" in url:
        match = re.search(r'viewkey=([a-zA-Z0-9]+)', url)
        if match:
            return match.group(1)
    clean_url = url.split('?')[0].rstrip('/')
    return clean_url.split('/')[-1]

def process_pipeline(video_url, folder, custom_title):
    video_id = extract_video_id(video_url)
    raw_output = f"raw_{video_id}.mp4"
    final_output = f"ready_{video_id}.mp4"
    
    print(f"--- KROK 1: Stahování videa {video_id} přes yt-dlp ---")
    # Chirurgické maskování za regulérní Chrome prohlížeč k proražení HTTP 410 ochrany
    download_cmd = (
        f'yt-dlp --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" '
        f'--no-check-certificates '
        f'-f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" '
        f'-o "{raw_output}" "{video_url}"'
    )
    subprocess.run(download_cmd, shell=True, check=True)
    
    print(f"--- KROK 2: FFmpeg transformace (Vertikální ořez + Instagram Kvalita) ---")
    # Přesný ořez na 720x1280 (poměr stran pro mobilní swipe), vysoký bitrate 2500k a bleskový start streamu
    ffmpeg_cmd = (
        f'ffmpeg -y -i "{raw_output}" '
        f'-vf "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280" '
        f'-vcodec libx264 -profile:v high -level 4.1 -pix_fmt yuv420p '
        f'-b:v 2500k -maxrate 3000k -bufsize 5000k -movflags +faststart '
        f'"{final_output}"'
    )
    subprocess.run(ffmpeg_cmd, shell=True, check=True)
    
    # Smazání surového videa z disku
    if os.path.exists(raw_output):
        os.remove(raw_output)

    print(f"--- KROK 3: Nahrávání na Cloudflare R2 do složky videos/{folder}/ ---")
    r2_client = boto3.client(
        's3',
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
        aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        config=Config(signature_version='s3v4')
    )
    
    # Přesná cesta podle tvé struktury v bucketu tikboo-media
    r2_key = f"videos/{folder}/{video_id}.mp4"
    
    r2_client.upload_file(
        Filename=final_output,
        Bucket=os.environ['R2_BUCKET_NAME'],
        Key=r2_key,
        ExtraArgs={'ContentType': 'video/mp4'}
    )
    
    # Smazání hotového videa z disku běžce po úspěšném uploadu
    if os.path.exists(final_output):
        os.remove(final_output)

    # Poskládání finální veřejné adresy přes tvou custom CDN doménu
    cdn_domain = os.environ.get('CF_CUSTOM_DOMAIN', 'cdn.tikboo.com').replace('https://', '').replace('http://', '')
    final_cdn_url = f"https://{cdn_domain}/{r2_key}"
    print(f"🚀 Video nahráno. Veřejný odkaz: {final_cdn_url}")

    print(f"--- KROK 4: Zápis čistých dat do db.json ---")
    db_path = "db.json"
    db_data = []
    
    if os.path.exists(db_path):
        try:
            with open(db_path, "r", encoding="utf-8") as f:
                db_data = json.load(f)
        except Exception:
            db_data = []

    # Struktura pro tvůj web s nativní R2 URL místo hnusného embedu
    new_entry = {
        "id": video_id,
        "source_url": video_url,
        "video_url": final_cdn_url,
        "folder": folder,
        "title": custom_title if custom_title else f"Video {video_id}",
        "type": "native_r2"
    }
    
    # Odstranění duplicity a vložení nového videa na začátek feedu
    db_data = [item for item in db_data if item.get("id") != video_id]
    db_data.insert(0, new_entry)

    with open(db_path, "w", encoding="utf-8") as f:
        json.dump(db_data, f, indent=2, ensure_ascii=False)
        
    print("🎯 db.json byla aktualizována a je připravena k pushnutí.")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Chyba: Chybí parametry skriptu.")
        sys.exit(1)
        
    url_arg = sys.argv[1]
    folder_arg = sys.argv[2]
    title_arg = sys.argv[3] if len(sys.argv) > 3 else "Premium Video"
    
    process_pipeline(url_arg, folder_arg, title_arg)
