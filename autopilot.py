import os
import sys
import json
import re
import subprocess
import requests
import boto3
from botocore.client import Config

def extract_video_id(url):
    if "viewkey=" in url:
        match = re.search(r'viewkey=([a-zA-Z0-9]+)', url)
        if match:
            return match.group(1)
    clean_url = url.split('?')[0].rstrip('/')
    return clean_url.split('/')[-1]

def get_direct_video_url(video_url):
    # Chirurgické vytažení přímého MP4 linku přes nezávislé API, které obchází Cloudflare/IP bany
    print("[Liso API] Dekóduji přímý odkaz na video...")
    api_url = f"https://api.v03.su/api/raw?url={video_url}"
    try:
        response = requests.get(api_url, timeout=15)
        if response.status_code == 200:
            data = response.json()
            # Hledáme nejvyšší dostupnou kvalitu (1080p -> 720p -> nejlepší dostupná)
            formats = data.get("formats", [])
            if formats:
                # Seřadíme od nejvyšší kvality
                formats.sort(key=lambda x: int(x.get("quality", 0)) if str(x.get("quality", "")).isdigit() else 0, reverse=True)
                direct_url = formats[0].get("url")
                if direct_url:
                    return direct_url
            
            # Záložní pokus o získání single streamu
            direct_url = data.get("url")
            if direct_url:
                return direct_url
        raise Exception(f"API vrátilo status kód {response.status_code}")
    except Exception as e:
        print(f"[Liso API] Selhal primární dekodér, zkouším záložní tunel... {str(e)}")
        # Alternativní API pro absolutní jistotu funkčnosti
        alt_api = f"https://api.savefrom.to/api/convert?url={video_url}"
        alt_response = requests.get(alt_api, timeout=15).json()
        if alt_response.get("url"):
            return alt_response.get("url")
        raise Exception("Všechny stahovací tunely byly zablokovány.")

def process_pipeline(video_url, folder, custom_title):
    video_id = extract_video_id(video_url)
    raw_output = f"raw_{video_id}.mp4"
    final_output = f"ready_{video_id}.mp4"
    
    # 1. KROK: Získání přímého MP4 odkazu bez návštěvy webu Pornhubu
    direct_mp4_url = get_direct_video_url(video_url)
    
    print(f"--- KROK 1: Stahování čistého streamu ze zabezpečeného tunelu ---")
    # Stáhneme přímo čistý video soubor, žádný scraping stránky se nekoná
    with requests.get(direct_mp4_url, stream=True, timeout=30) as r:
        r.raise_for_status()
        with open(raw_output, 'wb') as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)
                
    print(f"--- KROK 2: FFmpeg transformace (Vertikální ořez + Instagram Kvalita) ---")
    ffmpeg_cmd = (
        f'ffmpeg -y -i "{raw_output}" '
        f'-vf "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280" '
        f'-vcodec libx264 -profile:v high -level 4.1 -pix_fmt yuv420p '
        f'-b:v 2500k -maxrate 3000k -bufsize 5000k -movflags +faststart '
        f'"{final_output}"'
    )
    subprocess.run(ffmpeg_cmd, shell=True, check=True)
    
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
    
    r2_key = f"videos/{folder}/{video_id}.mp4"
    
    r2_client.upload_file(
        Filename=final_output,
        Bucket=os.environ['R2_BUCKET_NAME'],
        Key=r2_key,
        ExtraArgs={'ContentType': 'video/mp4'}
    )
    
    if os.path.exists(final_output):
        os.remove(final_output)

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

    new_entry = {
        "id": video_id,
        "source_url": video_url,
        "video_url": final_cdn_url,
        "folder": folder,
        "title": custom_title if custom_title else f"Video {video_id}",
        "type": "native_r2"
    }
    
    db_data = [item for item in db_data if item.get("id") != video_id]
    db_data.insert(0, new_entry)

    with open(db_path, "w", encoding="utf-8") as f:
        json.dump(db_data, f, indent=2, ensure_ascii=False)
        
    print("🎯 db.json byla aktualizována.")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Chyba: Chybí parametry.")
        sys.exit(1)
        
    url_arg = sys.argv[1]
    folder_arg = sys.argv[2]
    title_arg = sys.argv[3] if len(sys.argv) > 3 else "Premium Video"
    
    process_pipeline(url_arg, folder_arg, title_arg)
