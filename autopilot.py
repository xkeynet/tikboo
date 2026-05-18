import os
import sys
import json
import re
import time
import requests
import boto3

def clean_filename(text):
    text = re.sub(r'[^\w\s\.-]', '', text)
    return text.replace(' ', '%20')

def download_video(url, output_path):
    headers = {
        "User-Agent": "Mozilla/5.0"
    }

    response = requests.get(
        url,
        headers=headers,
        stream=True,
        allow_redirects=True,
        timeout=60
    )

    if response.status_code != 200:
        raise Exception(f"Download failed: HTTP {response.status_code}")

    content_type = response.headers.get("Content-Type", "").lower()
    print(f"Content-Type: {content_type}")

    with open(output_path, "wb") as file:
        for chunk in response.iter_content(chunk_size=8192):
            if chunk:
                file.write(chunk)

    file_size = os.path.getsize(output_path)
    print(f"Downloaded size: {file_size} bytes")

    if file_size < 500000:
        os.remove(output_path)
        raise Exception("Downloaded file is too small. This is probably not a real MP4 video.")

    with open(output_path, "rb") as file:
        header = file.read(32)

    if b"ftyp" not in header:
        os.remove(output_path)
        raise Exception("Downloaded file is not a valid MP4 file.")

def upload_to_r2(local_file, r2_key):
    endpoint = os.environ["R2_ENDPOINT"]

    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto"
    )

    bucket = os.environ["R2_BUCKET_NAME"]

    s3.upload_file(
        local_file,
        bucket,
        r2_key,
        ExtraArgs={
            "ContentType": "video/mp4"
        }
    )

def process_pipeline(video_url, folder, custom_title):
    if not custom_title or custom_title.strip() == "":
        custom_title = f"Video_{int(time.time())}"

    print(f"--- Processing: {custom_title} ---")

    safe_title = clean_filename(custom_title)
    local_filename = f"{safe_title}.mp4"

    print("⬇ Downloading video...")
    download_video(video_url, local_filename)

    r2_key = f"videos/{folder}/{safe_title}.mp4"

    print("☁ Uploading to Cloudflare R2...")
    upload_to_r2(local_filename, r2_key)

    public_url = os.environ["R2_PUBLIC_URL"].rstrip("/")
    final_cdn_url = f"{public_url}/{r2_key}"

    db_path = "db.json"
    db_data = []

    if os.path.exists(db_path):
        try:
            with open(db_path, "r", encoding="utf-8") as f:
                db_data = json.load(f)
        except Exception:
            db_data = []

    new_entry = {
        "id": safe_title.replace("%20", "_"),
        "source_url": video_url,
        "video_url": final_cdn_url,
        "folder": folder,
        "title": custom_title,
        "type": "native_r2"
    }

    db_data = [item for item in db_data if item.get("title") != custom_title]
    db_data.insert(0, new_entry)

    with open(db_path, "w", encoding="utf-8") as f:
        json.dump(db_data, f, indent=2, ensure_ascii=False)

    if os.path.exists(local_filename):
        os.remove(local_filename)

    print("✅ DONE")
    print(final_cdn_url)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Missing parameters.")
        sys.exit(1)

    url_arg = sys.argv[1]
    folder_arg = sys.argv[2]
    title_arg = sys.argv[3] if len(sys.argv) > 3 else ""

    process_pipeline(url_arg, folder_arg, title_arg)
