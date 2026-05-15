import sys
import json
import os
import re

def get_universal_embed(url, folder):
    # Vyčištění URL
    clean_url = url.split('?')[0].rstrip('/')
    video_id = clean_url.split('/')[-1]
    
    embed_url = url  # Základní link, pokud nic jiného netrefíme
    
    # Detekce známých webů
    if "xnxx.com" in url:
        match = re.search(r'video-([\d\w]+)', url)
        if match:
            embed_url = f"https://www.xnxx.com/embedframe/{match.group(1)}"
    elif "pornhub.com" in url:
        if "viewkey=" in url:
            id_only = url.split("viewkey=")[1].split("&")[0]
            embed_url = f"https://www.pornhub.com/embed/{id_only}"
    elif "xhamster.com" in url:
        embed_url = f"https://xhamster.com/embed/{video_id}"

    return {
        "id": video_id if video_id else str(os.urandom(4).hex()),
        "source_url": url,
        "embed_url": embed_url,
        "folder": folder,
        "title": f"Video {video_id}",
        "type": "embed"
    }

def update_db(new_video):
    db_file = 'db.json'
    data = []
    
    if os.path.exists(db_file):
        try:
            with open(db_file, 'r', encoding='utf-8') as f:
                content = f.read().strip()
                if content:
                    data = json.loads(content)
        except Exception as e:
            print(f"Chyba při čtení DB: {e}")
            data = []

    # Kontrola duplicity
    if any(item.get('id') == new_video['id'] for item in data):
        print("Video již existuje.")
        return

    data.append(new_video)
    
    with open(db_file, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print("Zapsáno do db.json.")

if __name__ == "__main__":
    if len(sys.argv) >= 3:
        video_entry = get_universal_embed(sys.argv[1], sys.argv[2])
        update_db(video_entry)
