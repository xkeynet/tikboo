import sys
import json
import os
import re

def get_universal_embed(url, folder):
    # Vyčištění URL
    clean_url = url.split('?')[0].rstrip('/')
    # Získání ID z konce URL
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

    # Generování ID, pokud neexistuje, nebo použití původního
    final_id = video_id if video_id else os.urandom(4).hex()

    return {
        "id": final_id,
        "source_url": url,
        "embed_url": embed_url,
        "folder": folder,
        "title": f"Video {final_id}",
        "type": "embed"
    }

def update_db(new_video):
    db_file = 'db.json'
    data = []
    
    # Načtení stávající databáze s ošetřením chyb
    if os.path.exists(db_file):
        try:
            with open(db_file, 'r', encoding='utf-8') as f:
                content = f.read().strip()
                if content:
                    data = json.loads(content)
        except Exception as e:
            print(f"Chyba při čtení DB: {e}")
            data = []

    # Přísná kontrola duplicity podle ID
    if any(item.get('id') == new_video['id'] for item in data):
        print(f"Upozornění: Video {new_video['id']} už v db.json existuje.")
        return

    # Přidání záznamu do seznamu
    data.append(new_video)
    
    # Zápis zpět do souboru s odsazením pro čitelnost
    try:
        with open(db_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print(f"Úspěch: Video {new_video['id']} uloženo do db.json.")
    except Exception as e:
        print(f"Kritická chyba zápisu: {e}")
        sys.exit(1)

if __name__ == "__main__":
    # Kontrola, zda byly předány oba argumenty (URL a Složka)
    if len(sys.argv) >= 3:
        video_entry = get_universal_embed(sys.argv[1], sys.argv[2])
        update_db(video_entry)
    else:
        print("Chyba: Skript vyžaduje 2 argumenty: URL a název složky.")
        sys.exit(1)
