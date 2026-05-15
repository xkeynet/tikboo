import sys
import json
import os
import re

def get_universal_embed(url, folder):
    # Vyčištění URL
    clean_url = url.split('?')[0].rstrip('/')
    # Získání ID z konce URL (funguje pro většinu webů)
    video_id = clean_url.split('/')[-1]
    
    embed_url = url  # Základní link (fallback)
    
    # Detekce a převod na embed formát
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

    # Vracíme strukturovaná data
    return {
        "id": video_id if video_id else os.urandom(4).hex(),
        "source_url": url,
        "embed_url": embed_url,
        "folder": folder,
        "title": f"Video {video_id}",
        "type": "embed"
    }

def update_db(new_video):
    db_file = 'db.json'
    data = []
    
    # Načtení stávající databáze
    if os.path.exists(db_file):
        try:
            with open(db_file, 'r', encoding='utf-8') as f:
                content = f.read().strip()
                if content:
                    data = json.loads(content)
        except Exception as e:
            print(f"Chyba při čtení DB: {e}")
            data = []

    # Ochrana proti duplicitám
    if any(item.get('id') == new_video['id'] for item in data):
        print(f"Video {new_video['id']} již v db.json existuje. Přeskakuji.")
        return

    # Přidání záznamu a uložení
    data.append(new_video)
    
    try:
        with open(db_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print(f"Úspěšně zapsáno do db.json: {new_video['id']}")
    except Exception as e:
        print(f"Chyba při zápisu do souboru: {e}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) >= 3:
        # Spuštění s parametry z příkazové řádky (GitHub Actions)
        video_entry = get_universal_embed(sys.argv[1], sys.argv[2])
        update_db(video_entry)
    else:
        print("Chyba: Nedostatek argumentů. Použití: python autopilot.py URL SLOŽKA")
        sys.exit(1)
